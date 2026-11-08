/**
 * `pnpm smoke` (SPEC.md's smoke rule): the enforcement of "no Panel is
 * empty". Brings the Stack up, waits for every service to answer healthy,
 * optionally replays the committed Fixtures and recorded Events through the
 * Collector, then queries every target on every committed dashboard and
 * fails unless each one returns at least one series. This is the
 * imperative shell: every spawn, every file-system read and every `fetch`
 * lives here, and the pure substitution and request-building logic lives in
 * `../src/smoke/index.ts`, which this script only calls.
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { TemplateVariableSchema } from '../src/schema/dashboard.js';
import { QueryResponseSchema } from '../src/schema/query-result.js';
import {
  assertAllDashboardsCovered,
  extractTargets,
  formatFailureReport,
  requestFor,
  seriesCount,
  substituteQuery,
  type DashboardCoverage,
  type Failure,
  type PanelTarget,
} from '../src/smoke/index.js';

const USAGE_LINE = 'usage: pnpm smoke [--no-replay]\n';

// WINDOW_MS must stay equal to the '1h' literal that src/smoke/index.ts's
// MACROS table substitutes for the $__range macro: both express the same
// one-hour query window, and a change to one must come with a change to
// the other.
const WINDOW_MS = 3_600_000;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DASHBOARDS_DIR = join(REPO_ROOT, 'compose', 'grafana', 'dashboards');

const HEALTH_URLS = [
  'http://localhost:13133/',
  'http://localhost:3100/ready',
  'http://localhost:9090/-/ready',
  'http://localhost:3000/api/health',
];
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 1000;

const QUERY_CONCURRENCY = 6;
const RETRY_MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 3000;

const TemplatingSchema = z.object({
  templating: z.object({ list: z.array(TemplateVariableSchema) }),
});

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function runInherited(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    const spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv; stdio: 'inherit' } = {
      stdio: 'inherit',
    };
    if (options.cwd !== undefined) {
      spawnOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      spawnOptions.env = options.env;
    }

    const child = spawn(command, [...args], spawnOptions);
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (exitCode) => {
      resolvePromise(exitCode);
    });
  });
}

/** Runs one child step to completion, writing a one-line stderr failure on a non-zero exit. */
async function runStep(
  label: string,
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  let exitCode: number | null;
  try {
    exitCode = await runInherited(command, args, options);
  } catch (error) {
    process.stderr.write(`${label} failed to start: ${describeError(error)}\n`);
    return false;
  }
  if (exitCode !== 0) {
    process.stderr.write(`${label} exited with code ${String(exitCode)}\n`);
    return false;
  }
  return true;
}

async function isHealthy(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Polls every url once per second until all answer 2xx or the deadline passes; returns the stragglers. */
async function waitForHealthy(urls: readonly string[]): Promise<string[]> {
  const deadlineMs = Date.now() + HEALTH_TIMEOUT_MS;
  let unhealthy = [...urls];

  for (;;) {
    const checks = await Promise.all(
      unhealthy.map(async (url) => ({ url, ok: await isHealthy(url) })),
    );
    unhealthy = checks.filter((check) => !check.ok).map((check) => check.url);
    if (unhealthy.length === 0 || Date.now() >= deadlineMs) {
      return unhealthy;
    }
    await sleep(HEALTH_POLL_MS);
  }
}

/** Runs `fn` over `items` in slices of `batchSize`, awaiting each slice before starting the next. */
async function runInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += batchSize) {
    const batch = items.slice(start, start + batchSize);
    const batchResults = await Promise.all(batch.map((item) => fn(item)));
    results.push(...batchResults);
  }
  return results;
}

interface QueryOutcome {
  target: PanelTarget;
  query: string;
  failure?: string;
}

async function runQuery(target: PanelTarget, query: string, endMs: number): Promise<QueryOutcome> {
  const request = requestFor({ target, endMs, windowMs: WINDOW_MS });

  let response: Response;
  try {
    response = await fetch(request.url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return { target, query, failure: `request failed: ${describeError(error)}` };
  }

  if (!response.ok) {
    return { target, query, failure: `http ${String(response.status)}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { target, query, failure: `unparsable response: ${describeError(error)}` };
  }

  const parsed = QueryResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { target, query, failure: `unparsable response: ${parsed.error.message}` };
  }

  if (parsed.data.status === 'error') {
    return {
      target,
      query,
      failure: `api error: ${parsed.data.error ?? parsed.data.errorType ?? 'unknown'}`,
    };
  }

  if (seriesCount(parsed.data) === 0) {
    return { target, query, failure: 'no series' };
  }

  return { target, query };
}

function hasFailure(outcome: QueryOutcome): outcome is QueryOutcome & { failure: string } {
  return outcome.failure !== undefined;
}

async function main(): Promise<void> {
  let values: { 'no-replay'?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        'no-replay': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  const startedAtMs = Date.now();

  const composeUp = await runStep(
    'docker compose up',
    'docker',
    ['compose', '-f', 'compose/docker-compose.yml', 'up', '-d', '--wait', '--wait-timeout', '60'],
    { cwd: REPO_ROOT },
  );
  if (!composeUp) {
    process.exitCode = 1;
    return;
  }

  const unhealthy = await waitForHealthy(HEALTH_URLS);
  if (unhealthy.length > 0) {
    for (const url of unhealthy) {
      process.stderr.write(`unhealthy: ${url}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write('stack: healthy\n');

  if (values['no-replay'] !== true) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    const endpoint = childEnv['OTEL_EXPORTER_OTLP_ENDPOINT'];
    if (endpoint === undefined || endpoint === '') {
      childEnv['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
    }

    const replayFixtures = await runStep('replay --fixtures', 'pnpm', ['replay', '--fixtures'], {
      cwd: REPO_ROOT,
      env: childEnv,
    });
    if (!replayFixtures) {
      process.exitCode = 1;
      return;
    }

    const replayEvents = await runStep('replay --events', 'pnpm', ['replay', '--events'], {
      cwd: REPO_ROOT,
      env: childEnv,
    });
    if (!replayEvents) {
      process.exitCode = 1;
      return;
    }

    // The Probe Server emits thirteen mcp_server_call Events through the
    // Collector, and this is what fills the MCP Servers dashboard.
    const conform = await runStep(
      'mcp:conform',
      'pnpm',
      ['mcp:conform', '--', 'tsx', 'src/probe-server/cli.ts'],
      { cwd: REPO_ROOT, env: childEnv },
    );
    if (!conform) {
      process.exitCode = 1;
      return;
    }
  }

  let dashboardFiles: string[];
  try {
    const entries = await readdir(DASHBOARDS_DIR);
    dashboardFiles = entries.filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    process.stderr.write(`failed to read ${DASHBOARDS_DIR}: ${describeError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  interface PreparedQuery {
    target: PanelTarget;
    query: string;
  }

  const prepared: PreparedQuery[] = [];
  const coverage: DashboardCoverage[] = [];
  let dashboardErrors = 0;

  for (const file of dashboardFiles) {
    try {
      const raw = await readFile(join(DASHBOARDS_DIR, file), 'utf8');
      const dashboard: unknown = JSON.parse(raw);
      const targets = extractTargets({ file, dashboard });
      coverage.push({ file, targets });
      const templating = TemplatingSchema.parse(dashboard);
      const variables = templating.templating.list;

      const panelCount = new Set(targets.map((target) => target.panelTitle)).size;
      process.stdout.write(
        `${file}: ${String(panelCount)} panels, ${String(targets.length)} targets\n`,
      );

      for (const target of targets) {
        const query = substituteQuery({ expr: target.expr, variables });
        prepared.push({ target: { ...target, expr: query }, query });
      }
    } catch (error) {
      process.stderr.write(`${file}: ${describeError(error)}\n`);
      process.exitCode = 1;
      dashboardErrors += 1;
    }
  }

  const uncovered = assertAllDashboardsCovered(coverage);
  if (uncovered.length > 0) {
    const uncoveredFailures: Failure[] = uncovered.map((file) => ({
      target: {
        dashboardFile: file,
        dashboardTitle: file,
        panelTitle: '(none)',
        refId: '',
        expr: '',
        datasourceType: '',
        datasourceUid: '',
        instant: false,
      },
      query: '',
      reason: 'dashboard contributes no target',
    }));
    process.stderr.write(`${formatFailureReport(uncoveredFailures)}\n`);
    process.exitCode = 1;
    return;
  }

  const endMs = Date.now();

  let failing = (
    await runInBatches(prepared, QUERY_CONCURRENCY, (item) =>
      runQuery(item.target, item.query, endMs),
    )
  ).filter(hasFailure);

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS && failing.length > 0; attempt += 1) {
    process.stdout.write(
      `retry ${String(attempt)}/5: ${String(failing.length)} target(s) still empty\n`,
    );
    await sleep(RETRY_DELAY_MS);
    const retryItems = failing.map((outcome) => ({ target: outcome.target, query: outcome.query }));
    failing = (
      await runInBatches(retryItems, QUERY_CONCURRENCY, (item) =>
        runQuery(item.target, item.query, endMs),
      )
    ).filter(hasFailure);
  }

  if (failing.length === 0 && dashboardErrors === 0) {
    const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1000);
    process.stdout.write(
      `dashboards: ${String(dashboardFiles.length)} covered, panel queries: ${String(prepared.length)}\n`,
    );
    process.stdout.write(
      `targets: ${String(prepared.length)} checked, all return at least one series\n`,
    );
    process.stdout.write(`${String(elapsedSeconds)}s elapsed\n`);
    process.stdout.write('grafana: http://localhost:3000\n');
    return;
  }

  if (failing.length === 0 && dashboardErrors > 0) {
    process.stderr.write(
      `${String(dashboardErrors)} dashboard file(s) could not be read or parsed; no panel was checked for them\n`,
    );
    return;
  }

  const failures: Failure[] = failing.map((outcome) => ({
    target: outcome.target,
    query: outcome.query,
    reason: outcome.failure,
  }));
  process.stderr.write(`${formatFailureReport(failures)}\n`);
  if (dashboardErrors > 0) {
    process.stderr.write(
      `${String(dashboardErrors)} dashboard file(s) could not be read or parsed; no panel was checked for them\n`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

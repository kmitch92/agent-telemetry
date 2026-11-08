// `pnpm bench` starts a real Agent and costs money (paid LLM API calls).
// Per CLAUDE.md, it runs only on an explicit
// instruction from the user for that specific run; this session must never
// invoke it on its own initiative.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { claudeCodeAdapter } from '../adapters/claude-code.js';
import { DEFAULT_EVENTS_PATH } from '../events/read.js';
import { createOtlpSender } from '../events/otlp.js';
import { sha256Hex } from '../hash.js';
import { projectFromProjectPath } from '../replayer/parsers/index.js';
import { createUlidFactory } from '../ulid.js';
import { runChecker } from './checker.js';
import { createLifecycleFs, executeRun, readEventsWindow } from './lifecycle.js';
import type { LifecycleDeps, RunInput } from './lifecycle.js';
import { assertCacheSupported, parseTaskYaml, parseVariantsYaml, resolveVariant } from './index.js';
import type { CacheState } from './index.js';
import { DEFAULT_RESULTS_PATH, upsertRuns } from './store.js';

/**
 * The thin CLI shell for `pnpm bench`. Follows the style of
 * `src/sessions/cli.ts`: argument parsing and
 * file reads live here; every computation lives in `./index.ts`, and every
 * effect lives in `./lifecycle.ts` and the edge modules it wraps.
 */

const USAGE_LINES = [
  'usage: pnpm bench --task <id> [options]',
  '',
  '  --task       required, the Task id; reads <tasks-dir>/<id>.yaml',
  "  --agent      default 'claude-code'; the only known Agent",
  "  --variant    default 'none'",
  "  --cache      default 'cold'; 'cold' or 'warm' ('warm' is blocked)",
  "  --reps       default '1', a positive integer",
  "  --tasks-dir  default 'tasks'",
  "  --variants   default 'configs/variants.yaml'",
  "  --runs-root  default 'runs'",
  "  --endpoint   default 'http://localhost:4318'",
  `  --events     default '${DEFAULT_EVENTS_PATH}'`,
  `  --results    default '${DEFAULT_RESULTS_PATH}'`,
  '  --help       print this usage block and exit 0',
  '',
].join('\n');

interface CliValues {
  task?: string;
  agent: string;
  variant: string;
  cache: string;
  reps: string;
  'tasks-dir': string;
  variants: string;
  'runs-root': string;
  endpoint: string;
  events: string;
  results: string;
  help: boolean;
}

function isKnownCache(value: string): value is CacheState {
  return value === 'cold' || value === 'warm';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function baseEnvFromProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

async function main(): Promise<void> {
  let values: CliValues;
  try {
    ({ values } = parseArgs({
      options: {
        task: { type: 'string' },
        agent: { type: 'string', default: 'claude-code' },
        variant: { type: 'string', default: 'none' },
        cache: { type: 'string', default: 'cold' },
        reps: { type: 'string', default: '1' },
        'tasks-dir': { type: 'string', default: 'tasks' },
        variants: { type: 'string', default: 'configs/variants.yaml' },
        'runs-root': { type: 'string', default: 'runs' },
        endpoint: { type: 'string', default: 'http://localhost:4318' },
        events: { type: 'string', default: DEFAULT_EVENTS_PATH },
        results: { type: 'string', default: DEFAULT_RESULTS_PATH },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n${USAGE_LINES}`);
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    process.stdout.write(USAGE_LINES);
    return;
  }

  if (values.task === undefined) {
    process.stderr.write(`--task is required\n${USAGE_LINES}`);
    process.exitCode = 1;
    return;
  }

  if (values.agent !== 'claude-code') {
    process.stderr.write(
      `unknown Agent '${values.agent}': only 'claude-code' is known; see docs/adding-an-agent.md to add another.\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (!isKnownCache(values.cache)) {
    process.stderr.write(`unknown cache state '${values.cache}': use 'cold' or 'warm'.\n`);
    process.exitCode = 1;
    return;
  }

  const reps = Number.parseInt(values.reps, 10);
  if (!Number.isInteger(reps) || reps <= 0 || String(reps) !== values.reps.trim()) {
    process.stderr.write(`--reps must be a positive integer, got '${values.reps}'.\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const taskText = await readFile(join(values['tasks-dir'], `${values.task}.yaml`), 'utf8');
    const task = parseTaskYaml(taskText);

    const variantsText = await readFile(values.variants, 'utf8');
    const variantsFile = parseVariantsYaml(variantsText);
    const variant = resolveVariant(variantsFile, values.variant);

    // Fails fast, before any Run directory is created, for the same
    // reason `executeRun` checks it first: a warm cache is blocked.
    assertCacheSupported(values.cache);

    const project = projectFromProjectPath(process.cwd(), sha256Hex);
    const baseEnv = baseEnvFromProcessEnv(process.env);

    const deps: LifecycleDeps = {
      runsRoot: values['runs-root'],
      eventsPath: values.events,
      resultsPath: values.results,
      endpoint: values.endpoint,
      project,
      projectPath: process.cwd(),
      baseEnv,
      adapter: claudeCodeAdapter,
      fs: createLifecycleFs(),
      ulid: createUlidFactory(),
      nowMs: Date.now,
      nowIso: () => new Date().toISOString(),
      runChecker,
      // `createOtlpSender` reads its endpoint from
      // `options.env.OTEL_EXPORTER_OTLP_ENDPOINT` and returns a disabled
      // sender when that variable is absent (src/events/otlp.ts:54-56), so
      // the endpoint is handed over as a one-key env rather than inherited
      // from the shell. Only that one key is passed: the sender also parses
      // `OTEL_RESOURCE_ATTRIBUTES` from the same object, and a stale value
      // inherited from the shell would overwrite the Run's own attributes.
      createSender: ({ serviceName, endpoint }) =>
        createOtlpSender({
          serviceName,
          env: { OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
        }),
      readWindow: readEventsWindow,
      upsertRuns,
      sleep,
    };

    for (let rep = 0; rep < reps; rep += 1) {
      const input: RunInput = {
        task,
        variantName: values.variant,
        variant,
        cache: values.cache,
        rep,
      };

      const row = await executeRun(input, deps);
      process.stdout.write(
        `${row.run_id} task=${row.task} variant=${row.variant} cache=${row.cache} rep=${String(row.rep)} pass=${String(row.pass)} turns=${String(row.turns)} wall_ms=${String(row.wall_ms)}\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

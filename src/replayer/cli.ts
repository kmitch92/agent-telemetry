import { parseArgs } from 'node:util';
import { open as fsOpen, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../hash.js';
import { createOtlpSender } from '../events/otlp.js';
import type { OtlpSender } from '../events/otlp.js';
import { DEFAULT_EVENTS_PATH, countEventLines } from '../events/read.js';
import { waitForSettle } from '../events/settle.js';
import type { SettleResult } from '../events/settle.js';
import { parseKindMapping } from './kind-mapping.js';
import { projectFromProjectPath } from './parsers/index.js';
import type { FixtureTranscript } from './plan.js';
import { claudeCodeTranscriptParser } from './parsers/claude-code.js';
import { buildEventsPlan, buildFixturePlan, countReceived } from './plan.js';
import type { EventsReplayPlan, ReceivedCounts, ReplayPlan } from './plan.js';

/**
 * The Replayer's command line (the `replayer` ticket, SPEC.md:594). This is
 * the imperative shell: every computation lives in `./plan.ts` and
 * `./kind-mapping.ts`; this module only reads files, derives the Project,
 * sends Events, and prints the report. Two modes, selected by exactly one of
 * `--fixtures` or `--events`:
 *   --fixtures  replays every Transcript Fixture under
 *               test/fixtures/transcripts/claude-code/ as OTLP Events.
 *   --events    re-posts the recorded Event Fixture
 *               test/fixtures/events/claude-code/01.jsonl verbatim.
 * `--dry-run` plans and prints without sending anything and without
 * touching data/events.jsonl.
 */

const USAGE_LINE = 'usage: pnpm replay --fixtures | --events [--dry-run]\n';

const FIXTURES_DIR = 'test/fixtures/transcripts/claude-code';
const EVENTS_FIXTURE_PATH = 'test/fixtures/events/claude-code/01.jsonl';
const COLLECTOR_CONFIG_PATH = 'compose/collector/config.yaml';

/** Minimal shape of a Node error that carries a `code`, used without a cast. */
interface ErrnoLike {
  code?: string;
}

function isErrnoException(error: unknown): error is ErrnoLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** STEP 6's baseline, copying scripts/record-live.ts:142-154's behaviour. */
interface Baseline {
  byteOffset: number;
  lineCount: number;
}

async function readBaseline(): Promise<Baseline> {
  let byteOffset = 0;
  try {
    const info = await stat(DEFAULT_EVENTS_PATH);
    byteOffset = info.size;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  const lineCount = await countEventLines();
  return { byteOffset, lineCount };
}

/** STEP 9, copying scripts/record-live.ts:229-260's behaviour verbatim. */
async function readAppendedWindow(byteOffset: number): Promise<string[]> {
  let size: number | undefined;
  try {
    const info = await stat(DEFAULT_EVENTS_PATH);
    size = info.size;
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      size = undefined;
    } else {
      throw error;
    }
  }

  if (size === undefined || size <= byteOffset) {
    return [];
  }

  const length = size - byteOffset;
  const buffer = Buffer.alloc(length);
  const handle = await fsOpen(DEFAULT_EVENTS_PATH, 'r');
  try {
    await handle.read(buffer, 0, length, byteOffset);
  } finally {
    await handle.close();
  }

  return buffer
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

/**
 * Keeps only the window lines that carry a resourceLogs envelope. The
 * Collector's file exporter interleaves resourceMetrics and resourceSpans
 * envelopes into the same file (compose/collector/config.yaml:145-152), and
 * classifyLine would score each of those as an unknown_kind outcome.
 */
function filterResourceLogsLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes('resourceLogs'));
}

function printSettleLine(result: SettleResult): void {
  process.stdout.write(
    `settle: reason=${result.reason} lineCount=${String(result.lineCount)} elapsedMs=${String(
      result.elapsedMs,
    )}\n`,
  );
}

function printOptionalCounts(received: ReceivedCounts): void {
  if (received.malformed > 0) {
    process.stdout.write(`malformed: ${String(received.malformed)}\n`);
  }
  if (received.unknownKind > 0) {
    process.stdout.write(`unknown_kind: ${String(received.unknownKind)}\n`);
  }
}

async function readFixtureTranscripts(): Promise<FixtureTranscript[]> {
  const entries = await readdir(FIXTURES_DIR);
  const names = entries.filter((name) => name.endsWith('.jsonl')).sort();

  const transcripts: FixtureTranscript[] = [];
  for (const name of names) {
    const text = await readFile(join(FIXTURES_DIR, name), 'utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    transcripts.push({ stem: name.replace(/\.jsonl$/, ''), lines });
  }
  return transcripts;
}

async function buildFixturePlanForProject(project: string): Promise<ReplayPlan> {
  const transcripts = await readFixtureTranscripts();
  return buildFixturePlan({ transcripts, project, parser: claudeCodeTranscriptParser });
}

async function buildEventsPlanFromFixture(): Promise<EventsReplayPlan> {
  const text = await readFile(EVENTS_FIXTURE_PATH, 'utf8');
  const lines = text.split('\n');

  const configText = await readFile(COLLECTOR_CONFIG_PATH, 'utf8');
  const mapping = parseKindMapping(configText);

  return buildEventsPlan({ lines, projectPath: process.cwd(), mapping });
}

/**
 * One sender per distinct `group.agent`, `serviceName` set to the Agent name.
 * Group A of the Normaliser runs `set(agent, service.name)`
 * (compose/collector/config.yaml:30), so a mismatched `serviceName` would
 * silently overwrite the Event's own `agent`. Every planned Event of every
 * group is emitted before any sender is shut down.
 */
async function sendFixturePlan(plan: ReplayPlan): Promise<void> {
  const sendersByAgent = new Map<string, OtlpSender>();

  function senderFor(agent: string): OtlpSender {
    const existing = sendersByAgent.get(agent);
    if (existing !== undefined) {
      return existing;
    }
    const created = createOtlpSender({ serviceName: agent, installSignalHandlers: false });
    sendersByAgent.set(agent, created);
    return created;
  }

  for (const group of plan.groups) {
    const sender = senderFor(group.agent);
    for (const planned of group.events) {
      sender.emit(planned.event, planned.eventName);
    }
  }

  for (const sender of sendersByAgent.values()) {
    await sender.shutdown();
  }
}

async function printFixturesDryRun(project: string): Promise<void> {
  const plan = await buildFixturePlanForProject(project);

  process.stdout.write('mode: fixtures\n');
  process.stdout.write(`project: ${project}\n`);
  process.stdout.write(`groups: ${String(plan.groups.length)}\n`);
  for (const group of plan.groups) {
    process.stdout.write(
      `group: run_id=${group.runId} session_id=${group.sessionId} events=${String(
        group.events.length,
      )}\n`,
    );
  }
  process.stdout.write(`expected: ${String(plan.totalEvents)}\n`);
  process.stdout.write('dry run: sent nothing\n');
}

async function printEventsDryRun(project: string): Promise<void> {
  const plan = await buildEventsPlanFromFixture();

  process.stdout.write('mode: events\n');
  process.stdout.write(`project: ${project}\n`);
  process.stdout.write(`posted: ${String(plan.lines.length)}\n`);
  process.stdout.write(`records: ${String(plan.records)}\n`);
  process.stdout.write(`expected: ${String(plan.expectedEvents)}\n`);
  process.stdout.write(`session_ids: ${String(plan.sessionIds.size)}\n`);
  process.stdout.write('dry run: sent nothing\n');
}

async function runFixtures(project: string): Promise<void> {
  const plan = await buildFixturePlanForProject(project);

  process.stdout.write('mode: fixtures\n');
  process.stdout.write(`project: ${project}\n`);
  process.stdout.write(`groups: ${String(plan.groups.length)}\n`);

  const baseline = await readBaseline();

  await sendFixturePlan(plan);
  process.stdout.write(`sent: ${String(plan.totalEvents)}\n`);

  const settleResult = await waitForSettle({ countLines: () => countEventLines() });
  printSettleLine(settleResult);

  process.stdout.write(`expected: ${String(plan.totalEvents)}\n`);

  const windowLines = await readAppendedWindow(baseline.byteOffset);
  const filteredWindowLines = filterResourceLogsLines(windowLines);
  const sessionIds = new Set(plan.groups.map((group) => group.sessionId));
  const received = countReceived(filteredWindowLines, sessionIds);

  process.stdout.write(`received: ${String(received.events)}\n`);
  printOptionalCounts(received);

  if (received.events < plan.totalEvents) {
    process.exitCode = 1;
  }
}

async function runEvents(project: string, endpoint: string): Promise<void> {
  const plan = await buildEventsPlanFromFixture();

  process.stdout.write('mode: events\n');
  process.stdout.write(`project: ${project}\n`);

  const baseline = await readBaseline();

  // This mode posts the recorded envelope itself, never through
  // createOtlpSender: that function builds its own payload from an Event,
  // and this mode must post exactly what a live Agent sends.
  const targetUrl = `${endpoint.replace(/\/+$/, '')}/v1/logs`;
  for (const line of plan.lines) {
    let response: Response;
    try {
      response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: line,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agent-telemetry: POST to ${targetUrl} failed (${message})\n`);
      process.exitCode = 1;
      return;
    }
    if (response.status < 200 || response.status > 299) {
      process.stderr.write(
        `agent-telemetry: POST to ${targetUrl} returned status ${String(response.status)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  process.stdout.write(`posted: ${String(plan.lines.length)}\n`);
  process.stdout.write(`records: ${String(plan.records)}\n`);
  process.stdout.write(`expected: ${String(plan.expectedEvents)}\n`);

  const settleResult = await waitForSettle({ countLines: () => countEventLines() });
  printSettleLine(settleResult);

  const windowLines = await readAppendedWindow(baseline.byteOffset);
  const filteredWindowLines = filterResourceLogsLines(windowLines);
  const received = countReceived(filteredWindowLines, plan.sessionIds);

  process.stdout.write(`received: ${String(received.events)}\n`);
  printOptionalCounts(received);

  if (received.events < plan.expectedEvents) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  let values: { fixtures?: boolean; events?: boolean; 'dry-run'?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        fixtures: { type: 'boolean', default: false },
        events: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  const fixtures = values.fixtures === true;
  const events = values.events === true;
  const dryRun = values['dry-run'] === true;

  if (fixtures === events) {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  // The Transcript Fixtures have their cwd redacted, so the real Project is
  // unrecoverable. This derivation gives the same `agent-telemetry-<8 hex>`
  // form the Collector itself would derive for a live Agent in this
  // repository (compose/collector/config.yaml:32-35): a documented
  // substitution, not a fabricated measurement.
  const project = projectFromProjectPath(process.cwd(), sha256Hex);

  if (dryRun) {
    if (fixtures) {
      await printFixturesDryRun(project);
    } else {
      await printEventsDryRun(project);
    }
    return;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint === undefined || endpoint === '') {
    process.stderr.write(
      'OTEL_EXPORTER_OTLP_ENDPOINT must be set, for example to http://localhost:4318\n',
    );
    process.exitCode = 1;
    return;
  }

  if (fixtures) {
    await runFixtures(project);
  } else {
    await runEvents(project, endpoint);
  }
}

await main();

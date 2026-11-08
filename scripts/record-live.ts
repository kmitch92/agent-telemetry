/**
 * Operator one-shot for the `record` command.
 *
 * Starts exactly one real Claude Code session inside a disposable scratch
 * project, waits for its Events to settle in the Collector's file exporter,
 * then writes the redacted appended window as the `claude-code` Adapter's
 * reference Fixture. This is the one script in the repository allowed to
 * start a paid Agent session, and only when an operator runs `pnpm record`.
 */
import { spawn } from 'node:child_process';
import { mkdir, open as fsOpen, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashId } from '../src/hash.js';
import { redactLine } from '../src/redact.js';
import { classifyLine } from '../src/events/line.js';
import { countEventLines, DEFAULT_EVENTS_PATH } from '../src/events/read.js';
import { waitForSettle } from '../src/events/settle.js';

const EVENTS_PATH = join(process.cwd(), DEFAULT_EVENTS_PATH);
const SCRATCH_DIR = join(process.cwd(), 'runs', 'record-probe');
const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'events', 'claude-code', '01.jsonl');
const FIXTURE_RELATIVE_PATH = 'test/fixtures/events/claude-code/01.jsonl';
const CHILD_TIMEOUT_MS = 180000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStringProp(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * STEP 1a-1b-1c. Aborts with a thrown `Error` on the first failure; `main`
 * turns that into the single required stderr line.
 */
async function preflight(): Promise<{ claudeVersion: string }> {
  const userPromptLogging = process.env['OTEL_LOG_USER_PROMPTS'];
  if (userPromptLogging !== undefined && userPromptLogging !== '') {
    throw new Error('OTEL_LOG_USER_PROMPTS is set; prompt text must never be exported, aborting');
  }

  let response: Response;
  try {
    response = await fetch('http://localhost:4318/v1/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceLogs: [] }),
    });
  } catch (error) {
    throw new Error(`Collector preflight POST to :4318/v1/logs failed: ${describeError(error)}`);
  }
  if (!response.ok) {
    throw new Error(`Collector preflight POST returned status ${String(response.status)}`);
  }

  const claudeVersion = await runClaudeVersion();
  return { claudeVersion };
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    if (options.cwd !== undefined) {
      spawnOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      spawnOptions.env = options.env;
    }

    const child = spawn(command, [...args], spawnOptions);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      reject(error);
    });

    child.on('close', (exitCode) => {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

async function runClaudeVersion(): Promise<string> {
  const result = await runCommand('claude', ['--version']);
  if (result.exitCode !== 0) {
    throw new Error(`claude --version exited with code ${String(result.exitCode)}`);
  }
  return result.stdout.trim();
}

/** STEP 2. The byte offset is what step 7 reads from; the line count is only reported. */
interface Baseline {
  byteOffset: number;
  lineCount: number;
}

async function readBaseline(): Promise<Baseline> {
  let byteOffset = 0;
  try {
    const info = await stat(EVENTS_PATH);
    byteOffset = info.size;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  const lineCount = await countEventLines();
  return { byteOffset, lineCount };
}

/** STEP 3. */
async function prepareScratchDir(): Promise<void> {
  await rm(SCRATCH_DIR, { recursive: true, force: true });
  await mkdir(SCRATCH_DIR, { recursive: true });
  await writeFile(join(SCRATCH_DIR, 'alpha.txt'), 'alpha\n', 'utf8');
  await writeFile(join(SCRATCH_DIR, 'beta.txt'), 'beta\n', 'utf8');
}

const CHILD_ENV_REMOVE = [
  'OTEL_LOG_USER_PROMPTS',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ATTENDED',
] as const;

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CHILD_ENV_REMOVE) {
    Reflect.deleteProperty(env, key);
  }
  env['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1';
  env['OTEL_LOGS_EXPORTER'] = 'otlp';
  env['OTEL_METRICS_EXPORTER'] = 'otlp';
  env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/protobuf';
  env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318';
  env['OTEL_LOGS_EXPORT_INTERVAL'] = '1000';
  env['OTEL_METRIC_EXPORT_INTERVAL'] = '1000';
  env['OTEL_RESOURCE_ATTRIBUTES'] = 'run_id=probe';
  return env;
}

/** STEP 4. */
async function runAgentSession(): Promise<CommandResult> {
  const args = [
    '-p',
    'List the files in this directory, then stop.',
    '--output-format',
    'json',
    '--allowedTools',
    'Bash(ls:*)',
  ];
  return runCommand('claude', args, {
    cwd: SCRATCH_DIR,
    env: buildChildEnv(),
    timeoutMs: CHILD_TIMEOUT_MS,
  });
}

/** STEP 5. Never logged: the caller only ever prints `hashId` of this value. */
function extractSessionId(parsedStdout: unknown): string | undefined {
  if (!isRecord(parsedStdout)) {
    return undefined;
  }
  const top = readStringProp(parsedStdout, 'session_id');
  if (top !== undefined) {
    return top;
  }
  for (const value of Object.values(parsedStdout)) {
    if (isRecord(value)) {
      const nested = readStringProp(value, 'session_id');
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

/** STEP 7. Reads only the bytes appended after `byteOffset`, never the whole file. */
async function readAppendedWindow(byteOffset: number): Promise<string[]> {
  let size: number | undefined;
  try {
    const info = await stat(EVENTS_PATH);
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
  const handle = await fsOpen(EVENTS_PATH, 'r');
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

/** STEP 8. The three envelope kinds the Collector's file exporter interleaves. */
type EnvelopeKind = 'resourceLogs' | 'resourceMetrics' | 'resourceSpans' | 'other';

function classifyEnvelopeKind(line: string): EnvelopeKind {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return 'other';
  }
  if (!isRecord(parsed)) {
    return 'other';
  }
  if ('resourceLogs' in parsed) {
    return 'resourceLogs';
  }
  if ('resourceMetrics' in parsed) {
    return 'resourceMetrics';
  }
  if ('resourceSpans' in parsed) {
    return 'resourceSpans';
  }
  return 'other';
}

interface WindowCounts {
  resourceLogs: number;
  resourceMetrics: number;
  resourceSpans: number;
  other: number;
}

function countWindowKinds(lines: readonly string[]): WindowCounts {
  const counts: WindowCounts = { resourceLogs: 0, resourceMetrics: 0, resourceSpans: 0, other: 0 };
  for (const line of lines) {
    const kind = classifyEnvelopeKind(line);
    counts[kind] += 1;
  }
  return counts;
}

function selectSessionLines(
  lines: readonly string[],
  sessionId: string | undefined,
): {
  selected: string[];
  selection: 'by-session-id' | 'whole-window-no-session-id' | 'whole-window-session-id-absent';
} {
  const resourceLogLines = lines.filter((line) => classifyEnvelopeKind(line) === 'resourceLogs');
  if (sessionId === undefined) {
    return { selected: resourceLogLines, selection: 'whole-window-no-session-id' };
  }
  const bySessionId = resourceLogLines.filter((line) => line.includes(sessionId));
  if (bySessionId.length > 0) {
    return { selected: bySessionId, selection: 'by-session-id' };
  }
  return { selected: resourceLogLines, selection: 'whole-window-session-id-absent' };
}

function redactSelectedLines(lines: readonly string[]): { redacted: string[]; failures: number } {
  const redacted: string[] = [];
  let failures = 0;
  for (const line of lines) {
    const result = redactLine(line, { hashId });
    if (result.ok) {
      redacted.push(result.line);
    } else {
      failures += 1;
    }
  }
  return { redacted, failures };
}

async function writeFixture(lines: readonly string[]): Promise<void> {
  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, lines.map((line) => `${line}\n`).join(''), 'utf8');
}

/** The raw OTLP `{key, value}` attribute shape, before any redaction. */
interface RawAttribute {
  key: string;
  value: unknown;
}

function isRawAttribute(value: unknown): value is RawAttribute {
  return isRecord(value) && typeof value['key'] === 'string';
}

function isAttributeArray(value: unknown): value is RawAttribute[] {
  return Array.isArray(value) && value.every(isRawAttribute);
}

function rawAttributeStringValue(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stringValue = value['stringValue'];
  return typeof stringValue === 'string' ? stringValue : undefined;
}

/** STEP 9d/9e working state, folded one redacted fixture line at a time. */
interface SummaryAccumulator {
  resourceAttributeKeys: Set<string>;
  eventRecordCounts: Map<string, number>;
  eventAttributeKeys: Map<string, Set<string>>;
  eventNameSources: Map<string, Set<'eventName field' | 'event.name attribute'>>;
}

function newSummaryAccumulator(): SummaryAccumulator {
  return {
    resourceAttributeKeys: new Set(),
    eventRecordCounts: new Map(),
    eventAttributeKeys: new Map(),
    eventNameSources: new Map(),
  };
}

function walkFixtureLine(line: string, accumulator: SummaryAccumulator): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }
  const resourceLogs = parsed['resourceLogs'];
  if (!Array.isArray(resourceLogs)) {
    return;
  }

  for (const resourceLogsEntry of resourceLogs) {
    if (!isRecord(resourceLogsEntry)) {
      continue;
    }
    const resource = resourceLogsEntry['resource'];
    if (isRecord(resource) && isAttributeArray(resource['attributes'])) {
      for (const attribute of resource['attributes']) {
        accumulator.resourceAttributeKeys.add(attribute.key);
      }
    }

    const scopeLogs = resourceLogsEntry['scopeLogs'];
    if (!Array.isArray(scopeLogs)) {
      continue;
    }
    for (const scopeLogsEntry of scopeLogs) {
      if (!isRecord(scopeLogsEntry)) {
        continue;
      }
      const logRecords = scopeLogsEntry['logRecords'];
      if (!Array.isArray(logRecords)) {
        continue;
      }
      for (const logRecord of logRecords) {
        if (!isRecord(logRecord)) {
          continue;
        }
        const attributes = isAttributeArray(logRecord['attributes']) ? logRecord['attributes'] : [];
        const eventNameField =
          typeof logRecord['eventName'] === 'string' ? logRecord['eventName'] : undefined;
        const nameAttribute = attributes.find((attribute) => attribute.key === 'event.name');
        const eventNameFromAttribute =
          nameAttribute !== undefined ? rawAttributeStringValue(nameAttribute.value) : undefined;
        const eventName = eventNameField ?? eventNameFromAttribute;
        if (eventName === undefined) {
          continue;
        }

        accumulator.eventRecordCounts.set(
          eventName,
          (accumulator.eventRecordCounts.get(eventName) ?? 0) + 1,
        );

        const keySet = accumulator.eventAttributeKeys.get(eventName) ?? new Set<string>();
        for (const attribute of attributes) {
          keySet.add(attribute.key);
        }
        accumulator.eventAttributeKeys.set(eventName, keySet);

        const sources =
          accumulator.eventNameSources.get(eventName) ??
          new Set<'eventName field' | 'event.name attribute'>();
        if (eventNameField !== undefined) {
          sources.add('eventName field');
        }
        if (eventNameFromAttribute !== undefined) {
          sources.add('event.name attribute');
        }
        accumulator.eventNameSources.set(eventName, sources);
      }
    }
  }
}

function tallyOutcomes(lines: readonly string[]): {
  event: number;
  unknownKind: number;
  malformed: number;
} {
  let event = 0;
  let unknownKind = 0;
  let malformed = 0;
  for (const line of lines) {
    for (const outcome of classifyLine(line)) {
      if (outcome.outcome === 'event') {
        event += 1;
      } else if (outcome.outcome === 'unknown_kind') {
        unknownKind += 1;
      } else {
        malformed += 1;
      }
    }
  }
  return { event, unknownKind, malformed };
}

/** STEP 9f/9g raw-attribute search. `atResourceLevel` is set once the walk enters a `resource` key. */
interface FoundAttribute {
  key: string;
  stringValue: string | undefined;
  atResourceLevel: boolean;
}

function collectAttributes(value: unknown, insideResource: boolean, found: FoundAttribute[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAttributes(item, insideResource, found);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (isRawAttribute(value)) {
    found.push({
      key: value.key,
      stringValue: rawAttributeStringValue(value.value),
      atResourceLevel: insideResource,
    });
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectAttributes(nested, insideResource || key === 'resource', found);
  }
}

function collectAttributesFromWindow(lines: readonly string[]): FoundAttribute[] {
  const found: FoundAttribute[] = [];
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    collectAttributes(parsed, false, found);
  }
  return found;
}

function findSessionIdentifierKeys(
  attributes: readonly FoundAttribute[],
  sessionId: string,
): string[] {
  const keys = new Set<string>();
  for (const attribute of attributes) {
    if (attribute.stringValue === sessionId) {
      keys.add(attribute.key);
    }
  }
  return [...keys].sort();
}

const SESSION_LIKE_PATTERN = /session|conversation/i;

function findSessionLikeKeys(attributes: readonly FoundAttribute[]): string[] {
  const keys = new Set<string>();
  for (const attribute of attributes) {
    if (SESSION_LIKE_PATTERN.test(attribute.key)) {
      keys.add(attribute.key);
    }
  }
  return [...keys].sort();
}

function findRunIdProbe(attributes: readonly FoundAttribute[]): {
  found: boolean;
  level: 'resource' | 'record' | undefined;
} {
  for (const attribute of attributes) {
    if (attribute.key === 'run_id' && attribute.stringValue === 'probe') {
      return { found: true, level: attribute.atResourceLevel ? 'resource' : 'record' };
    }
  }
  return { found: false, level: undefined };
}

/** STEP 9h. */
function collectMetricNames(parsed: unknown): Set<string> {
  const names = new Set<string>();
  if (!isRecord(parsed)) {
    return names;
  }
  const resourceMetrics = parsed['resourceMetrics'];
  if (!Array.isArray(resourceMetrics)) {
    return names;
  }
  for (const resourceMetricsEntry of resourceMetrics) {
    if (!isRecord(resourceMetricsEntry)) {
      continue;
    }
    const scopeMetrics = resourceMetricsEntry['scopeMetrics'];
    if (!Array.isArray(scopeMetrics)) {
      continue;
    }
    for (const scopeMetricsEntry of scopeMetrics) {
      if (!isRecord(scopeMetricsEntry)) {
        continue;
      }
      const metrics = scopeMetricsEntry['metrics'];
      if (!Array.isArray(metrics)) {
        continue;
      }
      for (const metric of metrics) {
        if (isRecord(metric) && typeof metric['name'] === 'string') {
          names.add(metric['name']);
        }
      }
    }
  }
  return names;
}

function collectMetricNamesFromWindow(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const line of lines) {
    if (classifyEnvelopeKind(line) !== 'resourceMetrics') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    for (const name of collectMetricNames(parsed)) {
      names.add(name);
    }
  }
  return names;
}

interface SummaryInput {
  claudeVersion: string;
  timedOut: boolean;
  settleResult: { reason: 'quiet' | 'max_elapsed'; lineCount: number; elapsedMs: number };
  windowCounts: WindowCounts;
  selection: 'by-session-id' | 'whole-window-no-session-id' | 'whole-window-session-id-absent';
  stdoutParseNote: string | undefined;
  accumulator: SummaryAccumulator;
  sessionId: string | undefined;
  sessionIdKeys: string[];
  sessionLikeKeys: string[];
  runIdProbe: { found: boolean; level: 'resource' | 'record' | undefined };
  metricNames: Set<string>;
  outcomeTally: { event: number; unknownKind: number; malformed: number };
  fixtureWritten: boolean;
  fixtureLineCount: number;
  fixturePath: string;
}

/** STEP 9. Built only from the REDACTED fixture lines, except 9c/9f/9g/9h, which say RAW. */
function buildSummary(input: SummaryInput): string {
  const lines: string[] = [];

  lines.push(`claude --version: ${input.claudeVersion}`);
  if (input.timedOut) {
    lines.push(`claude session timed out after ${String(CHILD_TIMEOUT_MS)}ms; continuing anyway`);
  }

  lines.push(
    `settle: reason=${input.settleResult.reason} lineCount=${String(
      input.settleResult.lineCount,
    )} elapsedMs=${String(input.settleResult.elapsedMs)}`,
  );

  lines.push(
    `window line counts: resourceLogs=${String(
      input.windowCounts.resourceLogs,
    )} resourceMetrics=${String(input.windowCounts.resourceMetrics)} resourceSpans=${String(
      input.windowCounts.resourceSpans,
    )} other=${String(input.windowCounts.other)}`,
  );

  if (input.selection === 'by-session-id') {
    lines.push('session selection: filtered window resourceLogs lines by the session identifier');
  } else if (input.selection === 'whole-window-no-session-id') {
    lines.push(
      'session selection: session identifier unknown from stdout; kept every resourceLogs line in the byte window',
    );
  } else {
    lines.push(
      'session selection: the session identifier appeared in no captured line; kept every resourceLogs line in the byte window',
    );
  }
  if (input.stdoutParseNote !== undefined) {
    lines.push(`stdout note: ${input.stdoutParseNote}`);
  }

  const eventNames = [...input.accumulator.eventRecordCounts.keys()].sort();
  if (eventNames.length === 0) {
    lines.push('event names: none seen');
  }
  for (const eventName of eventNames) {
    const count = input.accumulator.eventRecordCounts.get(eventName) ?? 0;
    const sources = input.accumulator.eventNameSources.get(eventName);
    const sourceList = sources !== undefined ? [...sources].sort().join(', ') : 'unknown';
    lines.push(`event name "${eventName}": records=${String(count)} nameSource=${sourceList}`);
    const keys = input.accumulator.eventAttributeKeys.get(eventName);
    const keyList = keys !== undefined ? [...keys].sort().join(', ') : '';
    lines.push(`  attribute keys: ${keyList}`);
  }

  const resourceKeyList = [...input.accumulator.resourceAttributeKeys].sort().join(', ');
  lines.push(`resource-level attribute keys: ${resourceKeyList}`);

  if (input.sessionId === undefined) {
    lines.push('session identifier unknown from stdout');
    lines.push(`session-like attribute keys: ${input.sessionLikeKeys.join(', ')}`);
  } else {
    lines.push(`session identifier attribute keys: ${input.sessionIdKeys.join(', ')}`);
  }

  lines.push(
    input.runIdProbe.found
      ? `OTEL_RESOURCE_ATTRIBUTES honoured: yes (${input.runIdProbe.level ?? 'unknown'} level)`
      : 'OTEL_RESOURCE_ATTRIBUTES honoured: no',
  );

  const metricNameList = [...input.metricNames].sort().join(', ');
  lines.push(`metric names: ${metricNameList === '' ? 'none seen' : metricNameList}`);

  lines.push(
    `classifyLine outcomes over fixture lines: event=${String(
      input.outcomeTally.event,
    )} unknown_kind=${String(input.outcomeTally.unknownKind)} malformed=${String(
      input.outcomeTally.malformed,
    )}`,
  );
  lines.push(
    'every line is expected to be unknown_kind: the Collector transform processor is still an empty list, so no line carries a normalised kind yet',
  );

  lines.push(
    `fixture: ${input.fixtureWritten ? 'wrote' : 'did not write'} ${String(
      input.fixtureLineCount,
    )} line(s) to ${input.fixturePath}`,
  );

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let preflightResult: { claudeVersion: string };
  try {
    preflightResult = await preflight();
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const baseline = await readBaseline();

    await prepareScratchDir();

    const sessionResult = await runAgentSession();
    if (sessionResult.timedOut) {
      process.stderr.write(
        `claude session timed out after ${String(CHILD_TIMEOUT_MS)}ms; continuing\n`,
      );
    }

    let parsedStdout: unknown;
    let stdoutParseNote: string | undefined;
    try {
      parsedStdout = JSON.parse(sessionResult.stdout);
    } catch (error) {
      stdoutParseNote = `stdout did not parse as JSON: ${describeError(error)}`;
    }
    const sessionId = stdoutParseNote === undefined ? extractSessionId(parsedStdout) : undefined;
    if (stdoutParseNote === undefined && sessionId === undefined) {
      stdoutParseNote = 'stdout parsed but carried no session_id property';
    }

    const settleResult = await waitForSettle({ countLines: () => countEventLines() });

    const windowLines = await readAppendedWindow(baseline.byteOffset);
    const windowCounts = countWindowKinds(windowLines);

    const { selected, selection } = selectSessionLines(windowLines, sessionId);
    const { redacted } = redactSelectedLines(selected);

    const fixtureWritten = redacted.length > 0;
    if (fixtureWritten) {
      await writeFixture(redacted);
    } else {
      process.exitCode = 1;
    }

    const accumulator = newSummaryAccumulator();
    for (const line of redacted) {
      walkFixtureLine(line, accumulator);
    }

    const rawAttributes = collectAttributesFromWindow(windowLines);
    const sessionIdKeys =
      sessionId !== undefined ? findSessionIdentifierKeys(rawAttributes, sessionId) : [];
    const sessionLikeKeys = sessionId === undefined ? findSessionLikeKeys(rawAttributes) : [];
    const runIdProbe = findRunIdProbe(rawAttributes);
    const metricNames = collectMetricNamesFromWindow(windowLines);
    const outcomeTally = tallyOutcomes(redacted);

    const summary = buildSummary({
      claudeVersion: preflightResult.claudeVersion,
      timedOut: sessionResult.timedOut,
      settleResult,
      windowCounts,
      selection,
      stdoutParseNote,
      accumulator,
      sessionId,
      sessionIdKeys,
      sessionLikeKeys,
      runIdProbe,
      metricNames,
      outcomeTally,
      fixtureWritten,
      fixtureLineCount: redacted.length,
      fixturePath: FIXTURE_RELATIVE_PATH,
    });

    process.stdout.write(summary);
    if (!fixtureWritten) {
      process.stderr.write('zero fixture lines selected; fixture file was not written\n');
    }
  } catch (error) {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  }
}

await main();

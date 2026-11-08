/**
 * Operator one-shot that rebuilds the `claude-code` Adapter's reference
 * Fixture from an already-recorded Events capture, without spawning the
 * paid `claude` CLI. Reads a source Events file (the recording snapshot),
 * keeps only the real Claude Code log lines, redacts them with the same
 * `redactLine` the live recorder uses, and writes the redacted lines
 * unchanged as `test/fixtures/events/claude-code/01.jsonl`. The Fixture
 * stays a faithful record of what the Agent emitted: nothing is added
 * after redaction.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hashId } from '../src/hash.js';
import { redactLine } from '../src/redact.js';
import { DEFAULT_EVENTS_PATH } from '../src/events/read.js';

const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'events', 'claude-code', '01.jsonl');

/** The scope name the real Claude Code OTLP export carries on its log records. */
const CLAUDE_CODE_SCOPE_NAME = 'com.anthropic.claude_code.events';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the scope name of the first scopeLogs entry of the first
 * resourceLogs entry, the shallow shape every line of this capture uses.
 * Returns `undefined` for anything that does not have that shape.
 */
function getFirstScopeName(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const resourceLogs = parsed['resourceLogs'];
  if (!isUnknownArray(resourceLogs)) {
    return undefined;
  }
  const firstResourceLogsEntry = resourceLogs[0];
  if (!isRecord(firstResourceLogsEntry)) {
    return undefined;
  }
  const scopeLogs = firstResourceLogsEntry['scopeLogs'];
  if (!isUnknownArray(scopeLogs)) {
    return undefined;
  }
  const firstScopeLogsEntry = scopeLogs[0];
  if (!isRecord(firstScopeLogsEntry)) {
    return undefined;
  }
  const scope = firstScopeLogsEntry['scope'];
  if (!isRecord(scope)) {
    return undefined;
  }
  const name = scope['name'];
  return typeof name === 'string' ? name : undefined;
}

/**
 * True for a line that is a real Claude Code log envelope: parses as JSON,
 * carries a top-level `resourceLogs` key, and whose first scope name is
 * `com.anthropic.claude_code.events`. This is what separates the real
 * recording from the synthetic line `send-test-event.ts` writes under the
 * `agent-telemetry` scope name.
 */
function isClaudeCodeLogLine(parsed: unknown): boolean {
  return (
    isRecord(parsed) &&
    'resourceLogs' in parsed &&
    getFirstScopeName(parsed) === CLAUDE_CODE_SCOPE_NAME
  );
}

async function main(): Promise<void> {
  const sourceArg = process.argv[2];
  const sourcePath = sourceArg !== undefined && sourceArg !== '' ? sourceArg : DEFAULT_EVENTS_PATH;

  let fileContents: string;
  try {
    fileContents = await readFile(sourcePath, 'utf8');
  } catch (error) {
    process.stderr.write(`failed to read ${sourcePath}: ${describeError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const allLines = fileContents.split('\n').filter((line) => line.trim() !== '');
  const linesRead = allLines.length;

  const keptLines: string[] = [];
  for (const line of allLines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isClaudeCodeLogLine(parsed)) {
      keptLines.push(line);
    }
  }

  if (keptLines.length === 0) {
    process.stderr.write(`zero lines kept from ${sourcePath}; nothing to write\n`);
    process.exitCode = 1;
    return;
  }

  const outputLines: string[] = [];
  for (const line of keptLines) {
    const result = redactLine(line, { hashId });
    if (!result.ok) {
      process.stderr.write(`redaction failed: ${result.reason}\n`);
      process.exitCode = 1;
      return;
    }
    outputLines.push(result.line);
  }

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, outputLines.map((line) => `${line}\n`).join(''), 'utf8');

  process.stdout.write(
    `source=${sourcePath} linesRead=${String(linesRead)} linesKept=${String(
      keptLines.length,
    )} linesWritten=${String(outputLines.length)}\n`,
  );
}

await main();

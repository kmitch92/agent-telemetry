/**
 * `pnpm mcp:conform` (the conformance procedure at
 * `docs/mcp-server-events.md:138-177`): starts an arbitrary command over
 * stdio, drives the fixed request script, waits for the settle rule, then
 * runs every check and prints a pass/fail table. This is the imperative
 * shell, the only module under `src/conform/` allowed to import `node:*`;
 * every pure rule it calls lives in the rest of `src/conform/`.
 *
 * Two dependencies the reader must know:
 * - This checker reads the Events file the Collector's file exporter writes
 *   (`compose/collector/config.yaml:123-128`), so the Stack must already be
 *   running before this command starts.
 * - The Collector's Normaliser writes no transform statement for
 *   `mcp_server.call` today (`compose/collector/config.yaml:48-55`), so
 *   every attribute this checker reads is the server's own, unaltered by
 *   the Normaliser. If a later change adds such a statement, this checker
 *   would start judging the Normaliser's output instead of the server's.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_EVENTS_PATH, countEventLines } from '../events/read.js';
import { waitForSettle } from '../events/settle.js';
import { JsonRpcResponseSchema, ToolsListResultSchema } from '../schema/conform.js';
import type { JsonRpcResponse } from '../schema/conform.js';
import { createUlidFactory } from '../ulid.js';
import { runChecks } from './checks.js';
import { parseConformLines } from './records.js';
import { buildConformScript, buildHandshakeMessages } from './script.js';
import { exitCodeFor, formatCheckTable } from './table.js';

const USAGE_LINE = 'usage: pnpm mcp:conform -- <command that starts the server> [args...]\n';

const DEFAULT_ENDPOINT = 'http://localhost:4318';
const ENDPOINT_CHECK_TIMEOUT_MS = 3000;
const TOOLS_LIST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 15000;
const CHILD_EXIT_GRACE_MS = 2000;
const NONCE_CHAR_COUNT = 16;

interface CliValues {
  endpoint?: string;
  'events-path'?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Minimal shape of a Node error that carries a `code`, used without a cast. */
interface ErrnoLike {
  code?: string;
}

function hasErrorCode(error: unknown): error is ErrnoLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT';
}

/**
 * Checks the Collector endpoint is reachable before the server under
 * test is started. Any HTTP response counts as reachable; only a thrown
 * error means the endpoint cannot be reached. The empty body injects no
 * event, so this check is harmless to run before the server starts.
 */
async function checkEndpointReachable(endpoint: string): Promise<boolean> {
  try {
    await fetch(`${endpoint}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(ENDPOINT_CHECK_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Buffers a child process's standard output into newline-framed JSON-RPC
 * messages, one per line, and resolves a waiter keyed by request id. A line
 * that is not valid JSON, or that fails `JsonRpcResponseSchema`, is silently
 * ignored, because a server may print other things on standard output.
 */
class ResponseReader {
  private buffer = '';
  private readonly waiters = new Map<number | string, (response: JsonRpcResponse) => void>();
  private readonly resolved = new Map<number | string, JsonRpcResponse>();

  feed(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line.trim() === '') {
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      return;
    }

    const parsed = JsonRpcResponseSchema.safeParse(parsedJson);
    if (!parsed.success || parsed.data.id === undefined || parsed.data.id === null) {
      return;
    }

    const id = parsed.data.id;
    const waiter = this.waiters.get(id);
    if (waiter !== undefined) {
      this.waiters.delete(id);
      waiter(parsed.data);
    } else {
      this.resolved.set(id, parsed.data);
    }
  }

  waitForResponse(id: number, timeoutMs: number): Promise<JsonRpcResponse> {
    const existing = this.resolved.get(id);
    if (existing !== undefined) {
      this.resolved.delete(id);
      return Promise.resolve(existing);
    }

    return new Promise<JsonRpcResponse>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`timed out waiting for a response to request id ${String(id)}`));
      }, timeoutMs);

      this.waiters.set(id, (response) => {
        clearTimeout(timer);
        resolvePromise(response);
      });
    });
  }
}

async function main(): Promise<void> {
  let values: CliValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        endpoint: { type: 'string' },
        'events-path': { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  const command = positionals[0];
  if (command === undefined) {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }
  const commandArgs = positionals.slice(1);

  const endpoint = values.endpoint ?? DEFAULT_ENDPOINT;
  const eventsPath = values['events-path'] ?? DEFAULT_EVENTS_PATH;

  const reachable = await checkEndpointReachable(endpoint);
  if (!reachable) {
    process.stderr.write(`cannot reach ${endpoint}: the Stack must be running\n`);
    process.exitCode = 2;
    return;
  }

  const runId = `conform-${createUlidFactory()()}`;

  const child = spawn(command, commandArgs, {
    stdio: 'pipe',
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_RESOURCE_ATTRIBUTES: `run_id=${runId}`,
    },
  });

  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;

  let childErrorMessage: string | undefined;
  child.on('error', (error) => {
    childErrorMessage ??= describeError(error);
  });

  stderr.pipe(process.stderr);

  const reader = new ResponseReader();
  stdout.on('data', (chunk: Buffer) => {
    reader.feed(chunk.toString('utf8'));
  });

  const startedOk = await new Promise<boolean>((resolvePromise) => {
    child.once('spawn', () => {
      resolvePromise(true);
    });
    child.once('error', () => {
      resolvePromise(false);
    });
  });

  if (!startedOk) {
    process.stderr.write(`failed to start ${command}: ${childErrorMessage ?? 'unknown error'}\n`);
    process.exitCode = 2;
    return;
  }

  for (const message of buildHandshakeMessages()) {
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  let toolsListResponse: JsonRpcResponse;
  try {
    toolsListResponse = await reader.waitForResponse(2, TOOLS_LIST_TIMEOUT_MS);
  } catch {
    process.stderr.write('timed out waiting for a tools/list response\n');
    child.kill();
    process.exitCode = 2;
    return;
  }

  const toolsListResult = ToolsListResultSchema.safeParse(toolsListResponse.result);
  if (!toolsListResult.success || toolsListResult.data.tools.length === 0) {
    process.stderr.write('the server listed no tool, so no tools/call request can be built\n');
    child.kill();
    process.exitCode = 2;
    return;
  }

  const nonceFactory = createUlidFactory();
  const nextNonce = (): string => nonceFactory().slice(-NONCE_CHAR_COUNT);
  const script = buildConformScript({ tools: toolsListResult.data.tools, nextNonce });

  for (const message of script.callMessages) {
    stdin.write(`${JSON.stringify(message)}\n`);
    if (message.id === undefined) {
      continue;
    }
    try {
      await reader.waitForResponse(message.id, CALL_TIMEOUT_MS);
    } catch {
      process.stderr.write(
        `timed out waiting for a response to request id ${String(message.id)}\n`,
      );
    }
  }

  stdin.end();

  const settleResult = await waitForSettle({ countLines: () => countEventLines(eventsPath) });
  process.stdout.write(
    `settled: ${settleResult.reason}, ${String(settleResult.elapsedMs)} ms elapsed\n`,
  );

  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((resolvePromise) => {
        child.once('exit', () => {
          resolvePromise();
        });
      }),
      sleepFor(CHILD_EXIT_GRACE_MS),
    ]);
  }

  let fileContents = '';
  try {
    fileContents = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }

  const { records, malformed } = parseConformLines(fileContents.split('\n'));
  if (malformed > 0) {
    process.stderr.write(`${String(malformed)} malformed line(s) in ${eventsPath}\n`);
  }

  const results = runChecks({
    records,
    runId,
    nonces: script.nonces,
    invalidRequestId: script.invalidRequestId,
  });

  process.stdout.write(`${formatCheckTable(results)}\n`);
  process.exitCode = exitCodeFor(results);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

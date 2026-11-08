import { statSync, readdirSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { classifyLine } from '../src/events/line.js';
import type { LineOutcome } from '../src/events/line.js';
import { DEFAULT_EVENTS_PATH } from '../src/events/read.js';
import type { Event } from '../src/schema/index.js';

/**
 * Exercises the real Collector end to end: POSTs Fixture lines (already
 * captured OTLP envelopes) to the OTLP HTTP receiver, then reads back
 * whatever the Normaliser wrote to the sink and classifies it. Skips
 * instead of failing when the Stack is not reachable, so this file is safe
 * to run on a machine with no Collector listening.
 */

const HEALTH_CHECK_URL = 'http://localhost:13133';
const OTLP_LOGS_URL = 'http://localhost:4318/v1/logs';
const FIXTURES_DIR = 'test/fixtures/events/claude-code';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 25000;
const TEST_TIMEOUT_MS = 40000;

/**
 * Synthetic working-directory path for the fixture resource. In production
 * the launcher supplies `project_path` through `OTEL_RESOURCE_ATTRIBUTES`,
 * and the Collector deletes it after deriving `project`; the Fixture itself
 * cannot carry a real path, because the redactor's keep-set has no entry
 * for one.
 */
const PROJECT_PATH_KEY = 'project_path';
const PROJECT_PATH = '/fixtures/probe-project';

const PROJECT_PATTERN = /^[^-]+(-[^-]+)*-[0-9a-f]{8}$/;

const FORBIDDEN_KEYS = [
  'prompt',
  'response',
  'user.email',
  'user.id',
  'user.account_id',
  'user.account_uuid',
  'organization.id',
  'project_path',
];

async function probeStack(): Promise<boolean> {
  try {
    const response = await fetch(HEALTH_CHECK_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

const stackUp = await probeStack();

const AttributeSchema = z.object({ key: z.string(), value: z.unknown() });
const ResourceSchema = z.looseObject({ attributes: z.array(AttributeSchema).optional() });
const ResourceLogsEntrySchema = z.looseObject({ resource: ResourceSchema.optional() });
const EnvelopeSchema = z.looseObject({ resourceLogs: z.array(ResourceLogsEntrySchema) });

const CountingLogRecordSchema = z.object({}).loose();
const CountingScopeLogsSchema = z.object({
  logRecords: z.array(CountingLogRecordSchema).optional(),
});
const CountingResourceLogsSchema = z.object({
  scopeLogs: z.array(CountingScopeLogsSchema).optional(),
});
const CountingEnvelopeSchema = z.object({
  resourceLogs: z.array(CountingResourceLogsSchema),
});

/**
 * Appends a synthetic `project_path` resource attribute to every
 * `resourceLogs` entry of one Fixture line, unless that entry already
 * carries one, then returns the line re-serialised.
 */
function withProjectPath(line: string): string {
  const parsed: unknown = JSON.parse(line);
  const envelope = EnvelopeSchema.parse(parsed);

  const resourceLogs = envelope.resourceLogs.map((entry) => {
    const existingAttributes = entry.resource?.attributes ?? [];
    const hasProjectPath = existingAttributes.some(
      (attribute) => attribute.key === PROJECT_PATH_KEY,
    );

    if (hasProjectPath) {
      return entry;
    }

    const attributes = [
      ...existingAttributes,
      { key: PROJECT_PATH_KEY, value: { stringValue: PROJECT_PATH } },
    ];

    return { ...entry, resource: { attributes } };
  });

  return JSON.stringify({ ...envelope, resourceLogs });
}

/** Counts `resourceLogs[].scopeLogs[].logRecords[].length` over one line. */
function countLogRecords(line: string): number {
  const parsed: unknown = JSON.parse(line);
  const result = CountingEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return 0;
  }

  let count = 0;
  for (const resourceLogsEntry of result.data.resourceLogs) {
    for (const scopeLogsEntry of resourceLogsEntry.scopeLogs ?? []) {
      count += scopeLogsEntry.logRecords?.length ?? 0;
    }
  }

  return count;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads only the bytes appended to `path` since `offset`, using a file
 * handle and a partial read, then keeps only complete, non-blank lines
 * whose parsed top-level key is `resourceLogs` (the metrics pipeline writes
 * `resourceMetrics` lines into the same sink, and those are not Events).
 * The final segment of the read is dropped whenever it is not known to be
 * complete, so a line still being written is never parsed half-written.
 */
async function readKeptLinesSince(path: string, offset: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const end = stat.size;
    if (end <= offset) {
      return [];
    }

    const length = end - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const text = buffer.toString('utf8');
    const segments = text.split('\n').slice(0, -1);

    return segments.filter((line) => {
      if (line.trim() === '') {
        return false;
      }
      const parsed: unknown = JSON.parse(line);
      return isPlainObject(parsed) && 'resourceLogs' in parsed;
    });
  } finally {
    await handle.close();
  }
}

type EventOutcome = Extract<LineOutcome, { outcome: 'event' }>;
type UnknownKindOutcome = Extract<LineOutcome, { outcome: 'unknown_kind' }>;
type MalformedOutcome = Extract<LineOutcome, { outcome: 'malformed' }>;

describe.skipIf(!stackUp)(
  'Normaliser through the real Collector (skipped when the Stack is not running)',
  () => {
    it(
      'classifies every posted Fixture line as an Event with the right Kind',
      async () => {
        const startOffset = statSync(DEFAULT_EVENTS_PATH).size;

        const fixtureFiles = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.jsonl'));
        const fixtureLines = fixtureFiles.flatMap((name) =>
          readFileSync(join(FIXTURES_DIR, name), 'utf8')
            .split('\n')
            .filter((line) => line.trim() !== ''),
        );
        expect(fixtureLines.length).toBeGreaterThan(0);

        const preparedLines = fixtureLines.map(withProjectPath);

        for (const line of preparedLines) {
          const response = await fetch(OTLP_LOGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: line,
          });
          expect(response.status).toBe(200);
        }

        const sentRecords = preparedLines.reduce((sum, line) => sum + countLogRecords(line), 0);

        let keptLines: string[] = [];
        let previousCount = -1;
        const pollStart = Date.now();
        while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
          keptLines = await readKeptLinesSince(DEFAULT_EVENTS_PATH, startOffset);
          if (keptLines.length > 0 && keptLines.length === previousCount) {
            break;
          }
          previousCount = keptLines.length;
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        expect(
          keptLines.length,
          `no resourceLogs line reached ${DEFAULT_EVENTS_PATH} within ${String(POLL_TIMEOUT_MS)} ms after posting ${String(preparedLines.length)} Fixture lines`,
        ).toBeGreaterThan(0);

        const outcomes = keptLines.flatMap((line) => classifyLine(line));

        // Acceptance: zero unknown kinds for claude-code.
        const unknownKindOutcomes = outcomes.filter(
          (outcome): outcome is UnknownKindOutcome => outcome.outcome === 'unknown_kind',
        );
        const claudeCodeUnknownKindCount = unknownKindOutcomes.filter(
          (outcome) => outcome.agent === 'claude-code',
        ).length;
        const distinctAgents = [
          ...new Set(unknownKindOutcomes.map((outcome) => outcome.agent)),
        ].sort();
        expect(
          claudeCodeUnknownKindCount,
          `expected 0 unknown_kind outcomes for agent 'claude-code', got ${String(claudeCodeUnknownKindCount)}; distinct agents seen: ${JSON.stringify(distinctAgents)}`,
        ).toBe(0);

        // Zero malformed lines: every record parses against the Event union.
        const malformedOutcomes = outcomes.filter(
          (outcome): outcome is MalformedOutcome => outcome.outcome === 'malformed',
        );
        const firstMalformedReason = malformedOutcomes[0]?.reason ?? '(none)';
        expect(
          malformedOutcomes.length,
          `expected 0 malformed outcomes, got ${String(malformedOutcomes.length)}; first reason: ${firstMalformedReason}`,
        ).toBe(0);

        // Every kept outcome is a classified Event, none unknown or malformed.
        const nonEventOutcomes = outcomes.filter((outcome) => outcome.outcome !== 'event');
        expect(
          nonEventOutcomes.length,
          `expected every outcome to be 'event', got ${String(nonEventOutcomes.length)} non-event outcomes out of ${String(outcomes.length)} total (sentRecords=${String(sentRecords)}, keptLines=${String(keptLines.length)})`,
        ).toBe(0);

        const eventOutcomes = outcomes.filter(
          (outcome): outcome is EventOutcome => outcome.outcome === 'event',
        );

        // The three Kinds the Fixture can produce.
        const kinds = [
          ...new Set(eventOutcomes.map((outcome) => outcome.record.event.kind)),
        ].sort();
        expect(kinds).toEqual(['model_call', 'prompt', 'tool_call']);

        // Every Event carries the one Agent this Fixture came from.
        expect(eventOutcomes.every((outcome) => outcome.record.event.agent === 'claude-code')).toBe(
          true,
        );

        // project is a derived basename-plus-hash, never a raw path.
        expect(
          eventOutcomes.every((outcome) => PROJECT_PATTERN.test(outcome.record.event.project)),
        ).toBe(true);

        // session_id survives the Normaliser as a non-empty string.
        expect(
          eventOutcomes.every(
            (outcome) =>
              typeof outcome.record.event.session_id === 'string' &&
              outcome.record.event.session_id.length > 0,
          ),
        ).toBe(true);

        // tool_type is derived, and a native tool carries no mcp_server.
        const toolCallEvents = eventOutcomes.filter(
          (outcome) => outcome.record.event.kind === 'tool_call',
        );
        expect(toolCallEvents.length).toBe(1);
        const toolCallOutcome = toolCallEvents[0];
        expect(toolCallOutcome).toBeDefined();
        if (toolCallOutcome !== undefined) {
          const { event } = toolCallOutcome.record;
          if (event.kind === 'tool_call') {
            expect(event.tool).toBe('Bash');
            expect(event.tool_type).toBe('native');
            expect(event.success).toBe(true);
            expect('mcp_server' in event).toBe(false);
          }
        }

        // prompt_length matches the one recorded prompt's character count.
        const promptEvents = eventOutcomes.filter(
          (outcome) => outcome.record.event.kind === 'prompt',
        );
        expect(promptEvents.length).toBe(1);
        const promptOutcome = promptEvents[0];
        expect(promptOutcome).toBeDefined();
        if (promptOutcome !== undefined) {
          const { event } = promptOutcome.record;
          if (event.kind === 'prompt') {
            expect(event.prompt_length).toBe(44);
          }
        }

        // Both model_call Events name a real model.
        const modelCallEvents = eventOutcomes.filter(
          (outcome) => outcome.record.event.kind === 'model_call',
        );
        expect(modelCallEvents.length).toBe(2);
        for (const outcome of modelCallEvents) {
          const { event } = outcome.record;
          if (event.kind === 'model_call') {
            expect(typeof event.model).toBe('string');
            expect(event.model.length).toBeGreaterThan(0);
          }
        }

        // Hard prohibitions 3 and 4: no event object holds a forbidden key.
        for (const outcome of eventOutcomes) {
          for (const key of FORBIDDEN_KEYS) {
            expect(key in outcome.record.event).toBe(false);
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'derives tool_type and mcp_server from an MCP tool name that holds an underscore',
      async () => {
        const startOffset = statSync(DEFAULT_EVENTS_PATH).size;

        const SESSION_ID = '11111111-2222-3333-4444-555555555555';
        const FIXED_TIME_UNIX_NANO = '1794105633683000000';
        const GMAIL_TOOL = 'mcp__claude_ai_Gmail__search_threads';
        const CONTEXT7_TOOL = 'mcp__context7__query-docs';
        const NATIVE_TOOL = 'Read';

        // Built in code rather than read from a Fixture: no recording holds
        // an MCP tool call, so this is the minimum OTLP envelope the
        // Normaliser needs to derive tool_type and mcp_server.
        const logRecords = [GMAIL_TOOL, CONTEXT7_TOOL, NATIVE_TOOL].map((toolName) => ({
          timeUnixNano: FIXED_TIME_UNIX_NANO,
          attributes: [
            { key: 'event.name', value: { stringValue: 'tool_result' } },
            { key: 'session.id', value: { stringValue: SESSION_ID } },
            { key: 'success', value: { stringValue: 'true' } },
            { key: 'tool_name', value: { stringValue: toolName } },
          ],
        }));

        const envelope = {
          resourceLogs: [
            {
              resource: {
                attributes: [
                  { key: 'service.name', value: { stringValue: 'claude-code' } },
                  { key: PROJECT_PATH_KEY, value: { stringValue: PROJECT_PATH } },
                ],
              },
              scopeLogs: [{ logRecords }],
            },
          ],
        };

        const response = await fetch(OTLP_LOGS_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(envelope),
        });
        expect(response.status).toBe(200);

        let keptLines: string[] = [];
        let previousCount = -1;
        const pollStart = Date.now();
        while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
          keptLines = await readKeptLinesSince(DEFAULT_EVENTS_PATH, startOffset);
          if (keptLines.length > 0 && keptLines.length === previousCount) {
            break;
          }
          previousCount = keptLines.length;
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        expect(
          keptLines.length,
          `no resourceLogs line reached ${DEFAULT_EVENTS_PATH} within ${String(POLL_TIMEOUT_MS)} ms after posting the synthetic MCP envelope`,
        ).toBeGreaterThan(0);

        const outcomes = keptLines.flatMap((line) => classifyLine(line));

        const malformedOutcomes = outcomes.filter(
          (outcome): outcome is MalformedOutcome => outcome.outcome === 'malformed',
        );
        const firstMalformedReason = malformedOutcomes[0]?.reason ?? '(none)';
        expect(
          malformedOutcomes.length,
          `expected 0 malformed outcomes, got ${String(malformedOutcomes.length)}; first reason: ${firstMalformedReason}`,
        ).toBe(0);

        const eventOutcomes = outcomes.filter(
          (outcome): outcome is EventOutcome => outcome.outcome === 'event',
        );
        expect(eventOutcomes.length).toBe(3);
        expect(eventOutcomes.every((outcome) => outcome.record.event.kind === 'tool_call')).toBe(
          true,
        );

        const byTool = new Map<string, Extract<Event, { kind: 'tool_call' }>>();
        for (const outcome of eventOutcomes) {
          const { event } = outcome.record;
          if (event.kind === 'tool_call') {
            byTool.set(event.tool, event);
          }
        }

        const gmailEvent = byTool.get(GMAIL_TOOL);
        expect(gmailEvent).toBeDefined();
        if (gmailEvent !== undefined) {
          expect(gmailEvent.tool_type).toBe('mcp');
          expect(gmailEvent.mcp_server).toBe('claude_ai_Gmail');
        }

        const context7Event = byTool.get(CONTEXT7_TOOL);
        expect(context7Event).toBeDefined();
        if (context7Event !== undefined) {
          expect(context7Event.tool_type).toBe('mcp');
          expect(context7Event.mcp_server).toBe('context7');
        }

        const readEvent = byTool.get(NATIVE_TOOL);
        expect(readEvent).toBeDefined();
        if (readEvent !== undefined) {
          expect(readEvent.tool_type).toBe('native');
          expect('mcp_server' in readEvent).toBe(false);
        }

        expect(eventOutcomes.every((outcome) => outcome.record.event.agent === 'claude-code')).toBe(
          true,
        );
        expect(
          eventOutcomes.every((outcome) => PROJECT_PATTERN.test(outcome.record.event.project)),
        ).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { claudeCodeTranscriptParser } from '../src/replayer/parsers/claude-code.js';
import type { ParseResult } from '../src/replayer/parsers/index.js';
import { EventSchema } from '../src/schema/events.js';
import {
  REPLAY_MODEL_CALL,
  REPLAY_PROMPT,
  REPLAY_TOOL_CALL,
  RUNNER_RUN_END,
} from '../src/events/event-names.js';
import { buildEventsPlan, buildFixturePlan, countReceived } from '../src/replayer/plan.js';
import type { FixtureTranscript } from '../src/replayer/plan.js';
import { parseKindMapping } from '../src/replayer/kind-mapping.js';

/**
 * Tests for the Replayer's planning module (`src/replayer/plan.ts`, not yet
 * written) and the collector-config Kind mapping it depends on
 * (`src/replayer/kind-mapping.ts`, not yet written). Neither module exists
 * yet, so every import above fails at module resolution: that failure, not
 * a passing or a logically-failing assertion, is this test's expected
 * result until a GREEN worker adds both files.
 *
 * Group A exercises `buildFixturePlan` against the 20 real Transcript
 * Fixtures already covered by `test/transcript-parser.test.ts`, reusing its
 * conventions for reading those Fixtures. Group B exercises `buildEventsPlan`
 * against the real Event Fixture
 * `test/fixtures/events/claude-code/01.jsonl`. Group C exercises
 * `countReceived` against hand-written lines.
 */

const FIXTURES_DIR = join('test', 'fixtures', 'transcripts', 'claude-code');
const EVENTS_FIXTURE_PATH = join('test', 'fixtures', 'events', 'claude-code', '01.jsonl');
const COLLECTOR_CONFIG_PATH = join('compose', 'collector', 'config.yaml');
const SYNTHETIC_PROJECT = 'agent-telemetry-deadbeef';

function fixtureStem(name: string): string {
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
}

function fixtureLines(name: string): string[] {
  const text = readFileSync(join(FIXTURES_DIR, name), 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

function parseFixture(name: string): ParseResult {
  return claudeCodeTranscriptParser.parse({
    lines: fixtureLines(name),
    project: SYNTHETIC_PROJECT,
  });
}

function countByKind(result: ParseResult, kind: 'model_call' | 'tool_call'): number {
  return result.events.filter((parsed) => parsed.event.kind === kind).length;
}

const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.jsonl'));

const fixtureTranscripts: FixtureTranscript[] = fixtureNames.map((name) => ({
  stem: fixtureStem(name),
  lines: fixtureLines(name),
}));

const fixturePlan = buildFixturePlan({
  transcripts: fixtureTranscripts,
  project: SYNTHETIC_PROJECT,
  parser: claudeCodeTranscriptParser,
});

describe('buildFixturePlan against the 20 real Fixtures', () => {
  it('produces one group per Fixture, 20 total', () => {
    expect(fixturePlan.groups.length).toBe(20);
  });

  it('gives every group the replay-prefixed runId and the stem as sessionId', () => {
    fixtureNames.forEach((name, index) => {
      const group = fixturePlan.groups[index];
      expect(group, name).toBeDefined();
      if (group !== undefined) {
        expect(group.runId, name).toBe(`replay-${fixtureStem(name)}`);
        expect(group.sessionId, name).toBe(fixtureStem(name));
      }
    });
  });

  it("gives every group the Fixture's own parsed Event count plus one", () => {
    fixtureNames.forEach((name, index) => {
      const group = fixturePlan.groups[index];
      const result = parseFixture(name);
      expect(group, name).toBeDefined();
      if (group !== undefined) {
        expect(group.events.length, name).toBe(result.events.length + 1);
      }
    });
  });

  it('places a run_end Event named RUNNER_RUN_END last in every group', () => {
    fixtureNames.forEach((name, index) => {
      const group = fixturePlan.groups[index];
      expect(group, name).toBeDefined();
      if (group === undefined) {
        return;
      }

      const last = group.events[group.events.length - 1];
      expect(last, name).toBeDefined();
      if (last !== undefined) {
        expect(last.event.kind, name).toBe('run_end');
        expect(last.eventName, name).toBe(RUNNER_RUN_END);
      }
    });
  });

  it('gives every Event in every group a value that validates against EventSchema', () => {
    for (const group of fixturePlan.groups) {
      for (const planned of group.events) {
        const outcome = EventSchema.safeParse(planned.event);
        expect(outcome.success, `${group.sessionId}: ${JSON.stringify(planned.event)}`).toBe(true);
      }
    }
  });

  it("stamps every Event in every group with that group's own runId, task and variant", () => {
    for (const group of fixturePlan.groups) {
      for (const planned of group.events) {
        expect(planned.event.run_id, group.sessionId).toBe(group.runId);
        expect(planned.event.task, group.sessionId).toBe('replay');
        expect(planned.event.variant, group.sessionId).toBe('replay');
      }
    }
  });

  it('names every non-run_end Event REPLAY_MODEL_CALL, REPLAY_TOOL_CALL or REPLAY_PROMPT by its Kind', () => {
    for (const group of fixturePlan.groups) {
      for (const planned of group.events) {
        if (planned.event.kind === 'model_call') {
          expect(planned.eventName, group.sessionId).toBe(REPLAY_MODEL_CALL);
        } else if (planned.event.kind === 'tool_call') {
          expect(planned.eventName, group.sessionId).toBe(REPLAY_TOOL_CALL);
        } else if (planned.event.kind === 'prompt') {
          expect(planned.eventName, group.sessionId).toBe(REPLAY_PROMPT);
        }
      }
    }
  });

  it('counts turns, tool_calls, mcp_server_calls and input_tokens on the synthetic run_end', () => {
    fixtureNames.forEach((name, index) => {
      const group = fixturePlan.groups[index];
      const result = parseFixture(name);
      const modelCallCount = countByKind(result, 'model_call');
      const toolCallCount = countByKind(result, 'tool_call');
      const expectedInputTokens = result.events.reduce((total, parsed) => {
        return parsed.event.kind === 'model_call'
          ? total + (parsed.event.input_tokens ?? 0)
          : total;
      }, 0);

      expect(group, name).toBeDefined();
      if (group === undefined) {
        return;
      }

      const last = group.events[group.events.length - 1];
      expect(last, name).toBeDefined();
      if (last === undefined) {
        return;
      }

      if (last.event.kind === 'run_end') {
        expect(last.event.turns, name).toBe(modelCallCount);
        expect(last.event.tool_calls, name).toBe(toolCallCount);
        expect(last.event.mcp_server_calls, name).toBe(0);
        expect(last.event.input_tokens, name).toBe(expectedInputTokens);
      } else {
        expect.fail(`${name}: last Event kind was not run_end`);
      }
    });
  });

  it('gives the synthetic run_end pass false, timed_out false, expected_tools_hit false, rep 0, and no exit_code', () => {
    for (const group of fixturePlan.groups) {
      const last = group.events[group.events.length - 1];
      expect(last, group.sessionId).toBeDefined();
      if (last === undefined) {
        continue;
      }

      if (last.event.kind === 'run_end') {
        expect(last.event.pass, group.sessionId).toBe(false);
        expect(last.event.timed_out, group.sessionId).toBe(false);
        expect(last.event.expected_tools_hit, group.sessionId).toBe(false);
        expect(last.event.rep, group.sessionId).toBe(0);
        expect(last.event.exit_code, group.sessionId).toBeUndefined();
      } else {
        expect.fail(`${group.sessionId}: last Event kind was not run_end`);
      }
    }
  });

  it('gives a totalEvents of exactly 2950 across the 20 real Fixtures', () => {
    // Measured corpus totals, test/transcript-parser.test.ts:105-111:
    // prompt 70, model_call 1900, tool_call 960, summing to 2930 parsed
    // Events across the 20 Fixtures. Every one of the 20 Fixtures gets
    // exactly one appended synthetic run_end Event, adding 20, so
    // totalEvents is 2930 + 20 = 2950.
    expect(fixturePlan.totalEvents).toBe(2950);
  });
});

describe('buildFixturePlan against a synthetic two-Transcript case', () => {
  const namedStem = 'session-two-transcript-case';
  const blankStem = 'blank-transcript';

  const namedLines = [
    JSON.stringify({
      type: 'user',
      sessionId: namedStem,
      timestamp: '2026-01-01T00:00:00.000Z',
      origin: { kind: 'human' },
      message: { content: 'a synthetic human prompt' },
    }),
  ];

  const syntheticPlan = buildFixturePlan({
    transcripts: [
      { stem: namedStem, lines: namedLines },
      { stem: blankStem, lines: ['', '   '] },
    ],
    project: SYNTHETIC_PROJECT,
    parser: claudeCodeTranscriptParser,
  });

  it('still gives the all-blank Transcript its own group, with sessionId falling back to the stem', () => {
    expect(syntheticPlan.groups.length).toBe(2);
    const blankGroup = syntheticPlan.groups[1];
    expect(blankGroup).toBeDefined();
    if (blankGroup !== undefined) {
      expect(blankGroup.sessionId).toBe(blankStem);
      expect(blankGroup.runId).toBe(`replay-${blankStem}`);
    }
  });

  it('gives the all-blank Transcript exactly one Event, the synthetic run_end, with wall_ms 0', () => {
    const blankGroup = syntheticPlan.groups[1];
    expect(blankGroup).toBeDefined();
    if (blankGroup === undefined) {
      return;
    }

    expect(blankGroup.events.length).toBe(1);
    const [only] = blankGroup.events;
    expect(only).toBeDefined();
    if (only === undefined) {
      return;
    }

    if (only.event.kind === 'run_end') {
      expect(only.event.wall_ms).toBe(0);
    } else {
      expect.fail('the only Event in the all-blank group was not run_end');
    }
  });
});

/** A tolerant shape covering only the fields Group B's own checks inspect. */
const EnvelopeAttributeSchema = z.object({
  key: z.string(),
  value: z.object({ stringValue: z.string().optional() }).optional(),
});

const EnvelopeResourceLogsSchema = z.object({
  resource: z.object({ attributes: z.array(EnvelopeAttributeSchema).optional() }).optional(),
});

const EnvelopeSchema = z.object({
  resourceLogs: z.array(EnvelopeResourceLogsSchema),
});

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-clones `value`, dropping every `project_path`-keyed entry from any
 * `attributes` array found anywhere inside it. Used to undo
 * `buildEventsPlan`'s own injected attribute before comparing a rewritten
 * line back to its original input, without an `as` cast anywhere.
 */
function withoutProjectPathAttribute(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => withoutProjectPathAttribute(item));
  }

  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'attributes' && Array.isArray(nested)) {
        const filtered = nested.filter((attribute) => {
          if (!isPlainRecord(attribute)) {
            return true;
          }
          return attribute['key'] !== 'project_path';
        });
        result[key] = filtered.map((attribute) => withoutProjectPathAttribute(attribute));
        continue;
      }

      result[key] = withoutProjectPathAttribute(nested);
    }
    return result;
  }

  return value;
}

describe('buildEventsPlan against the real Event Fixture', () => {
  const PROJECT_PATH = '/tmp/replay-test-project';

  const rawText = readFileSync(EVENTS_FIXTURE_PATH, 'utf8');
  // Not filtered, unlike `fixtureLines` above: the trailing blank line this
  // split produces is exactly what exercises buildEventsPlan's own
  // blank-skipping behaviour (check 13 below).
  const rawLines = rawText.split('\n');
  const nonBlankInputLines = rawLines.filter((line) => line.trim().length > 0);

  const configText = readFileSync(COLLECTOR_CONFIG_PATH, 'utf8');
  const mapping = parseKindMapping(configText);

  const eventsPlan = buildEventsPlan({
    lines: rawLines,
    projectPath: PROJECT_PATH,
    mapping,
  });

  it('counts 39 total logRecords entries across the Fixture', () => {
    expect(eventsPlan.records).toBe(39);
  });

  it('counts exactly 4 records whose event.name is a key of the mapping', () => {
    expect(eventsPlan.expectedEvents).toBe(4);
  });

  it('rewrites 7 lines, skipping the one blank input line', () => {
    expect(eventsPlan.lines.length).toBe(7);
  });

  it('collects exactly one distinct session.id value', () => {
    expect(eventsPlan.sessionIds.size).toBe(1);
  });

  it('adds the project_path resource attribute, with the given value, to every resourceLogs entry', () => {
    for (const outputLine of eventsPlan.lines) {
      const parsedEnvelope = EnvelopeSchema.safeParse(JSON.parse(outputLine));
      expect(parsedEnvelope.success).toBe(true);
      if (!parsedEnvelope.success) {
        continue;
      }

      for (const resourceLogsEntry of parsedEnvelope.data.resourceLogs) {
        const attributes = resourceLogsEntry.resource?.attributes ?? [];
        const projectPathAttribute = attributes.find(
          (attribute) => attribute.key === 'project_path',
        );
        expect(projectPathAttribute).toBeDefined();
        if (projectPathAttribute !== undefined) {
          expect(projectPathAttribute.value?.stringValue).toBe(PROJECT_PATH);
        }
      }
    }
  });

  it('changes nothing else: removing the injected attribute deep-equals the original input line', () => {
    expect(eventsPlan.lines.length).toBe(nonBlankInputLines.length);

    eventsPlan.lines.forEach((outputLine, index) => {
      const inputLine = nonBlankInputLines[index];
      expect(inputLine, `line ${String(index)}`).toBeDefined();
      if (inputLine === undefined) {
        return;
      }

      const cleanedOutput = withoutProjectPathAttribute(JSON.parse(outputLine));
      const originalInput: unknown = JSON.parse(inputLine);
      expect(cleanedOutput).toEqual(originalInput);
    });
  });
});

describe('countReceived over hand-written lines', () => {
  function promptEventLine(sessionId: string): string {
    return JSON.stringify({
      kind: 'prompt',
      agent: 'claude-code',
      session_id: sessionId,
      project: SYNTHETIC_PROJECT,
      prompt_length: 10,
    });
  }

  it('counts only the event outcomes whose session_id is a member of sessionIds, with no malformed or unknownKind', () => {
    const lines = [promptEventLine('a'), promptEventLine('b')];
    const counts = countReceived(lines, new Set(['a']));

    expect(counts.events).toBe(1);
    expect(counts.malformed).toBe(0);
    expect(counts.unknownKind).toBe(0);
  });

  it('counts one malformed line for invalid JSON', () => {
    const counts = countReceived(['not valid json {'], new Set(['a']));
    expect(counts.malformed).toBe(1);
  });

  it('counts one unknownKind line for a flat object carrying an agent but no valid kind', () => {
    const lines = [
      JSON.stringify({ agent: 'claude-code', session_id: 'a', project: SYNTHETIC_PROJECT }),
    ];
    const counts = countReceived(lines, new Set(['a']));

    expect(counts.unknownKind).toBe(1);
  });
});

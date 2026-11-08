import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeTranscriptParser } from '../src/replayer/parsers/claude-code.js';
import {
  mcpServerOf,
  projectFromProjectPath,
  toUnixNano,
  toolTypeOf,
  utf8ByteLength,
} from '../src/replayer/parsers/index.js';
import type { ParsedEvent, ParseResult } from '../src/replayer/parsers/index.js';
import { EventSchema } from '../src/schema/events.js';

/**
 * Tests for the Claude Code Transcript parser (`tickets.yaml:442-479`,
 * SPEC.md "Replayer and test beds"). Group A parses the 20 real Fixtures
 * under `test/fixtures/transcripts/claude-code/`. Group B builds synthetic
 * Transcripts by hand to pin down one behaviour at a time. Group C calls
 * the shared derivations directly.
 *
 * Measured corpus counts (own measuring script, run against the committed
 * Fixtures, by the PROMPT / MODEL_CALL / TOOL_CALL rules this brief gives):
 * every number below matched the plan's claimed numbers exactly, so no
 * discrepancy is recorded.
 *
 *   a9f9e599-38ee-0f7a-c75d-e2229697be9d.jsonl: prompt 1, model_call 18, tool_call 10, unpaired 0
 *   6ae17629-2413-6abe-6ae1-96610283fb22.jsonl: prompt 1, model_call 27, tool_call 15, unpaired 0
 *   f02c06ef-1fe2-9fbf-67c7-33dc7f5abcf6.jsonl: prompt 1, model_call 61, tool_call 27, unpaired 1
 *   corpus totals: prompt 70, model_call 1900, tool_call 960, unpaired 1, orphan 0
 *
 * `sessionId` also equals the Fixture file stem for every one of the 20
 * Fixtures (own measuring script, every file held exactly one distinct
 * `sessionId`/`session_id` value, and it equalled the file stem), so the
 * strict equality form of that check is used below, not the weaker
 * non-empty-string form.
 *
 * `f02c06ef-1fe2-9fbf-67c7-33dc7f5abcf6.jsonl` holds 28 total `tool_use`
 * blocks and 27 total `tool_result` blocks (own measuring script, counting
 * `message.content` array entries by `type`, run against the committed
 * Fixture). 28 minus the one unpaired `tool_use` gives the 27 `tool_call`
 * Events this Fixture produces.
 */

const FIXTURES_DIR = join('test', 'fixtures', 'transcripts', 'claude-code');
const SYNTHETIC_PROJECT = 'agent-telemetry-deadbeef';

/**
 * The 20 harvested Transcript Fixtures are excluded from version control
 * (23 MB) and regenerated locally with `pnpm harvest`, so this read must
 * never throw on a clean clone that lacks them.
 */
function listFixtureNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
}

const fixtureNames = listFixtureNames(FIXTURES_DIR);
const FIXTURES_USABLE = fixtureNames.length > 0;

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

function countByKind(
  events: readonly ParsedEvent[],
  kind: 'prompt' | 'model_call' | 'tool_call',
): number {
  return events.filter((parsed) => parsed.event.kind === kind).length;
}

interface NamedFixtureExpectation {
  name: string;
  prompt: number;
  modelCall: number;
  toolCall: number;
  unpaired: number;
}

const NAMED_FIXTURES: NamedFixtureExpectation[] = [
  {
    name: 'a9f9e599-38ee-0f7a-c75d-e2229697be9d.jsonl',
    prompt: 1,
    modelCall: 18,
    toolCall: 10,
    unpaired: 0,
  },
  {
    name: '6ae17629-2413-6abe-6ae1-96610283fb22.jsonl',
    prompt: 1,
    modelCall: 27,
    toolCall: 15,
    unpaired: 0,
  },
  {
    name: 'f02c06ef-1fe2-9fbf-67c7-33dc7f5abcf6.jsonl',
    prompt: 1,
    modelCall: 61,
    toolCall: 27,
    unpaired: 1,
  },
];

const CORPUS_TOTALS = {
  prompt: 70,
  modelCall: 1900,
  toolCall: 960,
  unpaired: 1,
  orphan: 0,
};

describe.skipIf(!FIXTURES_USABLE)(
  'claudeCodeTranscriptParser against the real Fixtures (skipped when no harvested Transcript fixture is present; run pnpm harvest)',
  () => {
    it('parses every Fixture with no throw, no malformed line, and no rejected Event', () => {
      for (const name of fixtureNames) {
        let result: ParseResult | undefined;
        expect(() => {
          result = parseFixture(name);
        }, name).not.toThrow();

        expect(result?.malformedLines, name).toBe(0);
        expect(result?.rejectedEvents, name).toBe(0);
      }
    });

    it('reports sessionId equal to the Fixture file stem for every Fixture', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        expect(result.sessionId, name).toBe(fixtureStem(name));
      }
    });

    it('produces only Events that validate against the Event union', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        for (const parsed of result.events) {
          const outcome = EventSchema.safeParse(parsed.event);
          expect(outcome.success, `${name}: ${JSON.stringify(parsed.event)}`).toBe(true);
        }
      }
    });

    it('matches the measured per-Kind and unpaired counts for the three named Fixtures', () => {
      for (const expectation of NAMED_FIXTURES) {
        const result = parseFixture(expectation.name);

        expect(countByKind(result.events, 'prompt'), expectation.name).toBe(expectation.prompt);
        expect(countByKind(result.events, 'model_call'), expectation.name).toBe(
          expectation.modelCall,
        );
        expect(countByKind(result.events, 'tool_call'), expectation.name).toBe(
          expectation.toolCall,
        );
        expect(result.unpairedToolUses.length, expectation.name).toBe(expectation.unpaired);
      }
    });

    it('matches the measured corpus totals across all 20 Fixtures', () => {
      let prompt = 0;
      let modelCall = 0;
      let toolCall = 0;
      let unpaired = 0;
      let orphan = 0;

      for (const name of fixtureNames) {
        const result = parseFixture(name);
        prompt += countByKind(result.events, 'prompt');
        modelCall += countByKind(result.events, 'model_call');
        toolCall += countByKind(result.events, 'tool_call');
        unpaired += result.unpairedToolUses.length;
        orphan += result.orphanToolResults.length;
      }

      expect(prompt).toBe(CORPUS_TOTALS.prompt);
      expect(modelCall).toBe(CORPUS_TOTALS.modelCall);
      expect(toolCall).toBe(CORPUS_TOTALS.toolCall);
      expect(unpaired).toBe(CORPUS_TOTALS.unpaired);
      expect(orphan).toBe(CORPUS_TOTALS.orphan);
    });

    it('reports the one unpaired tool use in f02c06ef..., never as a tool_call Event', () => {
      const name = 'f02c06ef-1fe2-9fbf-67c7-33dc7f5abcf6.jsonl';
      const result = parseFixture(name);

      expect(result.unpairedToolUses.length).toBe(1);
      const [unpaired] = result.unpairedToolUses;
      expect(unpaired).toBeDefined();

      if (unpaired !== undefined) {
        expect(typeof unpaired.tool_use_id === 'string' && unpaired.tool_use_id.length > 0).toBe(
          true,
        );
        expect(typeof unpaired.tool === 'string' && unpaired.tool.length > 0).toBe(true);
        expect(typeof unpaired.timeUnixNano === 'string' && unpaired.timeUnixNano.length > 0).toBe(
          true,
        );
      }

      // Measured directly against the committed Fixture (own script, counting
      // `tool_use` and `tool_result` blocks): 28 total tool_use blocks, 1
      // unpaired tool_use. The tool_call Event count must equal the tool_use
      // total minus the one unpaired tool_use: 28 - 1 = 27.
      expect(countByKind(result.events, 'tool_call')).toBe(28 - 1);
    });

    it('reports no fabricated duration_ms: every one present is an integer at least 0', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        for (const parsed of result.events) {
          if (parsed.event.kind === 'model_call' || parsed.event.kind === 'tool_call') {
            const durationMs = parsed.event.duration_ms;
            if (durationMs !== undefined) {
              expect(Number.isInteger(durationMs), name).toBe(true);
              expect(durationMs >= 0, name).toBe(true);
            }
          }
        }
      }
    });

    it('derives tool_type and mcp_server correctly for every tool_call Event', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        for (const parsed of result.events) {
          if (parsed.event.kind === 'tool_call') {
            if (parsed.event.tool.startsWith('mcp__')) {
              expect(parsed.event.tool_type, name).toBe('mcp');
              expect(parsed.event.mcp_server, name).not.toBeUndefined();
              expect((parsed.event.mcp_server ?? '').length > 0, name).toBe(true);
            } else {
              expect(parsed.event.tool_type, name).toBe('native');
              expect(parsed.event.mcp_server, name).toBeUndefined();
            }
          }
        }
      }
    });

    it('gives every Event the agent, session_id, and project resource attributes', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        for (const parsed of result.events) {
          expect(parsed.event.agent, name).toBe('claude-code');
          expect(parsed.event.session_id, name).toBe(fixtureStem(name));
          expect(parsed.event.project, name).toBe(SYNTHETIC_PROJECT);
        }
      }
    });

    it('gives every ParsedEvent a positive-integer-string timeUnixNano', () => {
      for (const name of fixtureNames) {
        const result = parseFixture(name);
        for (const parsed of result.events) {
          expect(parsed.timeUnixNano, name).toMatch(/^[0-9]+$/);
          expect(Number(parsed.timeUnixNano) > 0, name).toBe(true);
        }
      }
    });
  },
);

describe('claudeCodeTranscriptParser against synthetic Transcripts', () => {
  it('gives an empty result and sessionId undefined for an empty lines array', () => {
    const result = claudeCodeTranscriptParser.parse({ lines: [], project: SYNTHETIC_PROJECT });

    expect(result.events).toEqual([]);
    expect(result.unpairedToolUses).toEqual([]);
    expect(result.orphanToolResults).toEqual([]);
    expect(result.sessionId).toBeUndefined();
  });

  it('increments malformedLines and throws nothing for a line that is not JSON', () => {
    const lines = ['this is not json'];

    let result: ParseResult | undefined;
    expect(() => {
      result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    }).not.toThrow();

    expect(result?.malformedLines).toBe(1);
  });

  it('gives sessionId undefined and zero Events for a Transcript with no sessionId anywhere', () => {
    const lines = [JSON.stringify({ type: 'system', content: 'no session here' })];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(result.sessionId).toBeUndefined();
    expect(result.events.length).toBe(0);
  });

  it('increments skippedLines for an unknown top-level type', () => {
    const lines = [JSON.stringify({ type: 'attachment', sessionId: 'session-unknown-type' })];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(result.skippedLines).toBe(1);
  });

  it('yields no model_call for an assistant line with no message.usage', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-no-usage',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { model: 'claude-x', content: [] },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(countByKind(result.events, 'model_call')).toBe(0);
  });

  it('omits duration_ms on the second model_call when the time gap between two assistant lines is negative', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-negative-gap',
        timestamp: '2026-01-01T00:00:05.000Z',
        message: {
          model: 'claude-x',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-negative-gap',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const modelCalls = result.events.filter((parsed) => parsed.event.kind === 'model_call');

    expect(modelCalls.length).toBe(2);

    // Pass 3 sorts Events by time ascending, so the earlier-timestamped
    // second line sorts first in the output array; a positional index would
    // test the wrong Event. The first line has no previous line, and the
    // second line's gap to the first is negative, so both model_call
    // Events omit duration_ms.
    for (const modelCall of modelCalls) {
      if (modelCall.event.kind === 'model_call') {
        expect(modelCall.event.duration_ms).toBeUndefined();
      }
    }
  });

  it('omits duration_ms on a first model_call with no previous timestamped line', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-first-call',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const [first] = result.events.filter((parsed) => parsed.event.kind === 'model_call');

    expect(first).toBeDefined();
    if (first !== undefined && first.event.kind === 'model_call') {
      expect(first.event.duration_ms).toBeUndefined();
    }
  });

  it('gives tool_type mcp and mcp_server probe for a tool_use named mcp__probe__echo', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-mcp-tool',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [{ type: 'tool_use', id: 'toolu_mcp_1', name: 'mcp__probe__echo', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-mcp-tool',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_mcp_1', content: 'ok', is_error: false },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const toolCalls = result.events.filter((parsed) => parsed.event.kind === 'tool_call');

    expect(toolCalls.length).toBe(1);
    const [toolCall] = toolCalls;
    expect(toolCall).toBeDefined();
    if (toolCall !== undefined && toolCall.event.kind === 'tool_call') {
      expect(toolCall.event.tool_type).toBe('mcp');
      expect(toolCall.event.mcp_server).toBe('probe');
    }
  });

  it('maps is_error to success: true carries false, false carries true, absent carries true', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-success-mapping',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [
            { type: 'tool_use', id: 'toolu_true', name: 'ToolErrorTrue', input: {} },
            { type: 'tool_use', id: 'toolu_false', name: 'ToolErrorFalse', input: {} },
            { type: 'tool_use', id: 'toolu_absent', name: 'ToolErrorAbsent', input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-success-mapping',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_true', content: 'x', is_error: true },
            { type: 'tool_result', tool_use_id: 'toolu_false', content: 'x', is_error: false },
            { type: 'tool_result', tool_use_id: 'toolu_absent', content: 'x' },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const toolCalls = result.events.filter((parsed) => parsed.event.kind === 'tool_call');

    expect(toolCalls.length).toBe(3);

    function successFor(toolName: string): boolean | undefined {
      const parsed = toolCalls.find(
        (candidate) => candidate.event.kind === 'tool_call' && candidate.event.tool === toolName,
      );
      return parsed !== undefined && parsed.event.kind === 'tool_call'
        ? parsed.event.success
        : undefined;
    }

    expect(successFor('ToolErrorTrue')).toBe(false);
    expect(successFor('ToolErrorFalse')).toBe(true);
    expect(successFor('ToolErrorAbsent')).toBe(true);
  });

  it('counts result_bytes from only the text blocks of an array-shaped tool_result.content', () => {
    const textBlockValue = 'hello';
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-array-content',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [{ type: 'tool_use', id: 'toolu_array', name: 'Bash', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-array-content',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_array',
              is_error: false,
              content: [
                { type: 'text', text: textBlockValue },
                { type: 'image', source: { type: 'base64', data: 'ignored' } },
                { type: 'tool_reference', tool_name: 'Bash' },
              ],
            },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const [toolCall] = result.events.filter((parsed) => parsed.event.kind === 'tool_call');

    expect(toolCall).toBeDefined();
    if (toolCall !== undefined && toolCall.event.kind === 'tool_call') {
      expect(toolCall.event.result_bytes).toBe(utf8ByteLengthForTest(textBlockValue));
    }
  });

  it('gives result_bytes 0 for an empty-string tool_result.content', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        sessionId: 'session-empty-content',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          model: 'claude-x',
          content: [{ type: 'tool_use', id: 'toolu_empty', name: 'Bash', input: {} }],
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: 'session-empty-content',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_empty', content: '', is_error: false },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const [toolCall] = result.events.filter((parsed) => parsed.event.kind === 'tool_call');

    expect(toolCall).toBeDefined();
    if (toolCall !== undefined && toolCall.event.kind === 'tool_call') {
      expect(toolCall.event.result_bytes).toBe(0);
    }
  });

  it('reports a tool_result with no matching tool_use in orphanToolResults', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-orphan',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_orphan', content: 'x', is_error: false },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(result.orphanToolResults.length).toBe(1);
    expect(result.orphanToolResults[0]?.tool_use_id).toBe('toolu_orphan');
  });

  it('yields no prompt for a user line whose origin.kind is task-notification', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-task-notification',
        timestamp: '2026-01-01T00:00:00.000Z',
        origin: { kind: 'task-notification' },
        message: { content: 'a task notification, not a human prompt' },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(countByKind(result.events, 'prompt')).toBe(0);
  });

  it('yields no prompt for a user line with isMeta true', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-is-meta',
        timestamp: '2026-01-01T00:00:00.000Z',
        isMeta: true,
        message: { content: 'meta content, not a human prompt' },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(countByKind(result.events, 'prompt')).toBe(0);
  });

  it('yields no prompt for a user line with isCompactSummary true', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-is-compact-summary',
        timestamp: '2026-01-01T00:00:00.000Z',
        isCompactSummary: true,
        message: { content: 'a compact summary, not a human prompt' },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    expect(countByKind(result.events, 'prompt')).toBe(0);
  });

  it('yields one prompt with the UTF-8 byte length of a multi-byte prompt for origin.kind human', () => {
    const promptText = 'café report';
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-human-prompt',
        timestamp: '2026-01-01T00:00:00.000Z',
        origin: { kind: 'human' },
        message: { content: promptText },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const [prompt] = result.events.filter((parsed) => parsed.event.kind === 'prompt');

    expect(prompt).toBeDefined();
    if (prompt !== undefined && prompt.event.kind === 'prompt') {
      expect(prompt.event.prompt_length).toBe(utf8ByteLengthForTest(promptText));
    }
  });

  it('yields one prompt whose prompt_length sums only the text blocks of an array-shaped message.content', () => {
    const textBlockOne = 'café notes';
    const textBlockTwo = 'plain text';
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-array-prompt',
        timestamp: '2026-01-01T00:00:00.000Z',
        origin: { kind: 'human' },
        message: {
          content: [
            { type: 'text', text: textBlockOne },
            { type: 'image', source: { type: 'base64', data: 'ignored' } },
            { type: 'text', text: textBlockTwo },
          ],
        },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });
    const prompts = result.events.filter((parsed) => parsed.event.kind === 'prompt');

    expect(prompts.length).toBe(1);
    const [prompt] = prompts;
    expect(prompt).toBeDefined();
    if (prompt !== undefined && prompt.event.kind === 'prompt') {
      expect(prompt.event.prompt_length).toBe(
        utf8ByteLengthForTest(textBlockOne) + utf8ByteLengthForTest(textBlockTwo),
      );
    }
  });

  it('yields one prompt for a user line with no origin key at all', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        sessionId: 'session-no-origin-key',
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { content: 'a human prompt with no origin key' },
      }),
    ];

    const result = claudeCodeTranscriptParser.parse({ lines, project: SYNTHETIC_PROJECT });

    // A Transcript's first user line carries no `origin` key, and 19 of the
    // 20 Fixtures start that way, so this line is a human prompt.
    expect(countByKind(result.events, 'prompt')).toBe(1);
  });
});

describe('the shared derivations', () => {
  it('toolTypeOf classifies a native tool and an mcp__ tool differently', () => {
    expect(toolTypeOf('Bash')).toBe('native');
    expect(toolTypeOf('mcp__probe__echo')).toBe('mcp');
  });

  it('mcpServerOf extracts the server name from an mcp__ tool, and gives undefined for a native tool', () => {
    expect(mcpServerOf('mcp__probe__echo')).toBe('probe');
    expect(mcpServerOf('Bash')).toBeUndefined();
  });

  it('toUnixNano converts a valid ISO-8601 string, and gives undefined for an unparseable one', () => {
    expect(toUnixNano('2026-01-01T00:00:00.000Z')).not.toBeUndefined();
    expect(toUnixNano('not a timestamp')).toBeUndefined();
  });

  it('utf8ByteLength counts bytes, not characters, for ASCII and multi-byte text', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('café')).toBe(5);
  });

  it('projectFromProjectPath applies the SPEC.md:227 form with an injected sha256Hex', () => {
    const fixedHash = 'deadbeef'.repeat(8);
    const fakeSha256Hex = (): string => fixedHash;

    const result = projectFromProjectPath('/home/user/my-project', fakeSha256Hex);

    expect(result).toBe('my-project-deadbeef');
  });
});

/**
 * UTF-8 byte length computed independently of `utf8ByteLength` under test,
 * via the global `Buffer`, so a test asserting against `utf8ByteLength`'s
 * own output would be circular reasoning.
 */
function utf8ByteLengthForTest(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

import { EventSchema } from '../../schema/events.js';
import type { Event } from '../../schema/events.js';
import {
  TextBlockSchema,
  ToolResultBlockSchema,
  ToolUseBlockSchema,
  TranscriptLineSchema,
} from '../../schema/transcript-claude-code.js';
import type { TranscriptLine } from '../../schema/transcript-claude-code.js';
import { mcpServerOf, toUnixNano, toolTypeOf, utf8ByteLength } from './index.js';
import type {
  OrphanToolResult,
  ParseResult,
  ParsedEvent,
  TranscriptParser,
  UnpairedToolUse,
} from './index.js';

/**
 * The Claude Code Transcript parser (SPEC.md:594), a pure function from
 * Transcript lines to Events. `agent` is the `service.name` value Claude
 * Code emits, taken verbatim from
 * `test/fixtures/events/claude-code/01.jsonl:1`
 * (`"key":"service.name","value":{"stringValue":"claude-code"}`), confirmed
 * by `docs/agent-events.md:363`
 * ("the resource of every output record carries `agent` `claude-code`").
 *
 * The parse runs three passes: PASS 1 reads every line in order, building a
 * `prompt` or `model_call` payload where one applies, and collecting every
 * `tool_use` and `tool_result` block along with this line's own time. PASS 2
 * joins a `tool_use` to its `tool_result` by `tool_use_id`, producing a
 * `tool_call` payload for every joined pair and reporting every unjoined
 * block. PASS 3 attaches the resource attributes, validates every built
 * Event against `EventSchema`, and sorts the survivors by time.
 */

/** `agent: 'claude-code'` on every Event this parser builds. */
const AGENT = 'claude-code';

/** A `tool_use` block this parser can still pair with a `tool_result`. */
interface CollectedToolUse {
  id: string;
  tool: string;
  timeMs: number;
  timeUnixNano: string;
}

/** A `tool_result` block this parser can still pair with a `tool_use`. */
interface CollectedToolResult {
  toolUseId: string;
  success: boolean;
  resultBytes: number;
  timeMs: number;
  timeUnixNano: string;
}

/** The fields a `model_call` Event needs, apart from the resource attributes. */
interface PendingModelCall {
  kind: 'model_call';
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
}

/** The fields a `tool_call` Event needs, apart from the resource attributes. */
interface PendingToolCall {
  kind: 'tool_call';
  tool: string;
  success: boolean;
  tool_type: 'mcp' | 'native';
  mcp_server?: string;
  duration_ms?: number;
  result_bytes?: number;
}

/** The fields a `prompt` Event needs, apart from the resource attributes. */
interface PendingPrompt {
  kind: 'prompt';
  prompt_length: number;
}

type PendingPayload = PendingModelCall | PendingToolCall | PendingPrompt;

/** One Event this parser still has to validate and attach resource attributes to. */
interface PendingEvent {
  payload: PendingPayload;
  timeUnixNano: string;
}

/** This line's time, as both the millisecond number and the nanosecond string. */
interface LineTime {
  ms: number;
  nano: string;
}

/**
 * Resolves a Transcript line's own time, or `undefined` when the line
 * carries no `timestamp` or an unparseable one. A line with no usable time
 * contributes no Event and no `tool_use`/`tool_result` block, because every
 * downstream field this parser reports (`timeUnixNano` on a `ParsedEvent`,
 * an `UnpairedToolUse`, an `OrphanToolResult`) requires a real time string.
 */
function lineTime(timestamp: string | undefined): LineTime | undefined {
  if (timestamp === undefined) {
    return undefined;
  }

  const nano = toUnixNano(timestamp);
  if (nano === undefined) {
    return undefined;
  }

  return { ms: Date.parse(timestamp), nano };
}

/**
 * The gap, in milliseconds, between `previousMs` and `currentMs`. Omitted
 * (via `undefined`) when there is no previous time, and omitted when the
 * gap is negative, so `duration_ms` is never fabricated.
 */
function gapMs(previousMs: number | undefined, currentMs: number): number | undefined {
  if (previousMs === undefined) {
    return undefined;
  }

  const gap = currentMs - previousMs;
  return gap < 0 ? undefined : gap;
}

/**
 * The UTF-8 byte count of a `message.content` or `tool_result.content`
 * value: a string gives its own bytes, an array sums the byte length of
 * every block whose `type` is `'text'`. An `image` block and any other
 * block type contribute nothing: an `image` block's base64 payload was
 * already replaced by the redactor, so counting it would measure the
 * placeholder, not the real result or prompt.
 */
function textBytesFromContent(content: string | Record<string, unknown>[] | undefined): number {
  if (typeof content === 'string') {
    return utf8ByteLength(content);
  }

  if (!Array.isArray(content)) {
    return 0;
  }

  let total = 0;
  for (const block of content) {
    const parsedText = TextBlockSchema.safeParse(block);
    if (parsedText.success) {
      total += utf8ByteLength(parsedText.data.text);
    }
  }
  return total;
}

/** True when a user line's `message.content` carries at least one `tool_result` block. */
function toolResultBlocksOf(line: TranscriptLine): Record<string, unknown>[] {
  return Array.isArray(line.message?.content) ? line.message.content : [];
}

/**
 * The four-condition PROMPT rule: no `tool_result` block on the line (the
 * caller already checked this), `isMeta` is not `true`, `isCompactSummary`
 * is not `true`, and `origin.kind` is `'human'` when `origin` is present.
 */
function passesPromptRule(line: TranscriptLine): boolean {
  if (line.isMeta === true || line.isCompactSummary === true) {
    return false;
  }

  return line.origin === undefined || line.origin.kind === 'human';
}

/** Compares two nanosecond epoch strings as BigInt, never as a JS number. */
function compareTimeUnixNano(a: string, b: string): number {
  const bigA = BigInt(a);
  const bigB = BigInt(b);
  if (bigA < bigB) {
    return -1;
  }
  if (bigA > bigB) {
    return 1;
  }
  return 0;
}

export const claudeCodeTranscriptParser: TranscriptParser = {
  agent: AGENT,
  parse(input): ParseResult {
    let malformedLines = 0;
    let skippedLines = 0;
    let rejectedEvents = 0;
    let sessionId: string | undefined;

    const validLines: TranscriptLine[] = [];

    for (const rawLine of input.lines) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawLine);
      } catch {
        malformedLines += 1;
        continue;
      }

      const parsedLine = TranscriptLineSchema.safeParse(parsedJson);
      if (!parsedLine.success) {
        skippedLines += 1;
        continue;
      }

      const line = parsedLine.data;
      if (sessionId === undefined && line.sessionId !== undefined && line.sessionId.length > 0) {
        sessionId = line.sessionId;
      }

      validLines.push(line);
    }

    const pendingEvents: PendingEvent[] = [];
    const toolUses: CollectedToolUse[] = [];
    const toolResults: CollectedToolResult[] = [];
    let previousTimeMs: number | undefined;

    for (const line of validLines) {
      if (line.type === 'user') {
        const time = lineTime(line.timestamp);
        let hasToolResult = false;

        for (const block of toolResultBlocksOf(line)) {
          const parsedResult = ToolResultBlockSchema.safeParse(block);
          if (!parsedResult.success) {
            continue;
          }

          hasToolResult = true;
          if (time !== undefined) {
            toolResults.push({
              toolUseId: parsedResult.data.tool_use_id,
              success: parsedResult.data.is_error !== true,
              resultBytes: textBytesFromContent(parsedResult.data.content),
              timeMs: time.ms,
              timeUnixNano: time.nano,
            });
          }
        }

        if (!hasToolResult) {
          if (passesPromptRule(line) && time !== undefined) {
            pendingEvents.push({
              payload: {
                kind: 'prompt',
                prompt_length: textBytesFromContent(line.message?.content),
              },
              timeUnixNano: time.nano,
            });
          } else {
            skippedLines += 1;
          }
        }

        if (time !== undefined) {
          previousTimeMs = time.ms;
        }
      } else if (line.type === 'assistant') {
        const time = lineTime(line.timestamp);
        const usage = line.message?.usage;
        const model = line.message?.model;

        if (usage !== undefined && model !== undefined && model.length > 0 && time !== undefined) {
          const reasoningTokens = usage.output_tokens_details?.thinking_tokens;
          const durationMs = gapMs(previousTimeMs, time.ms);
          pendingEvents.push({
            payload: {
              kind: 'model_call',
              model,
              ...(usage.input_tokens === undefined ? {} : { input_tokens: usage.input_tokens }),
              ...(usage.output_tokens === undefined ? {} : { output_tokens: usage.output_tokens }),
              ...(usage.cache_read_input_tokens === undefined
                ? {}
                : { cache_read_tokens: usage.cache_read_input_tokens }),
              ...(usage.cache_creation_input_tokens === undefined
                ? {}
                : { cache_write_tokens: usage.cache_creation_input_tokens }),
              ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
              ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
            },
            timeUnixNano: time.nano,
          });
        } else {
          skippedLines += 1;
        }

        if (time !== undefined) {
          const contentBlocks = Array.isArray(line.message?.content) ? line.message.content : [];
          for (const block of contentBlocks) {
            const parsedUse = ToolUseBlockSchema.safeParse(block);
            if (parsedUse.success) {
              toolUses.push({
                id: parsedUse.data.id,
                tool: parsedUse.data.name,
                timeMs: time.ms,
                timeUnixNano: time.nano,
              });
            }
          }

          previousTimeMs = time.ms;
        }
      } else {
        skippedLines += 1;
      }
    }

    // PASS 2: join every tool_use to the tool_result sharing its id. A
    // duplicate tool_result id keeps its first occurrence only, matching the
    // first-seen convention this parser already uses for sessionId.
    const toolResultByUseId = new Map<string, CollectedToolResult>();
    for (const toolResult of toolResults) {
      if (!toolResultByUseId.has(toolResult.toolUseId)) {
        toolResultByUseId.set(toolResult.toolUseId, toolResult);
      }
    }

    const matchedToolUseIds = new Set<string>();
    const unpairedToolUses: UnpairedToolUse[] = [];

    for (const toolUse of toolUses) {
      const matched = toolResultByUseId.get(toolUse.id);
      if (matched === undefined) {
        unpairedToolUses.push({
          tool_use_id: toolUse.id,
          tool: toolUse.tool,
          timeUnixNano: toolUse.timeUnixNano,
        });
        continue;
      }

      matchedToolUseIds.add(toolUse.id);
      const mcpServer = mcpServerOf(toolUse.tool);
      const durationMs = gapMs(toolUse.timeMs, matched.timeMs);
      pendingEvents.push({
        payload: {
          kind: 'tool_call',
          tool: toolUse.tool,
          success: matched.success,
          tool_type: toolTypeOf(toolUse.tool),
          ...(mcpServer === undefined ? {} : { mcp_server: mcpServer }),
          ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
          result_bytes: matched.resultBytes,
        },
        timeUnixNano: toolUse.timeUnixNano,
      });
    }

    const orphanToolResults: OrphanToolResult[] = [];
    for (const toolResult of toolResults) {
      if (!matchedToolUseIds.has(toolResult.toolUseId)) {
        orphanToolResults.push({
          tool_use_id: toolResult.toolUseId,
          timeUnixNano: toolResult.timeUnixNano,
        });
      }
    }

    // PASS 3: attach resource attributes, validate, and sort. When no line
    // ever carried a sessionId, this parser builds zero Events: a Resource
    // attribute set with no session_id would always fail EventSchema, so
    // nothing is even attempted.
    const events: ParsedEvent[] = [];

    if (sessionId !== undefined) {
      const resolvedSessionId = sessionId;
      const candidateEvents: ParsedEvent[] = [];

      for (const pending of pendingEvents) {
        const candidate: Record<string, unknown> = {
          ...pending.payload,
          agent: AGENT,
          session_id: resolvedSessionId,
          project: input.project,
        };

        const parsedEvent = EventSchema.safeParse(candidate);
        if (parsedEvent.success) {
          const event: Event = parsedEvent.data;
          candidateEvents.push({ event, timeUnixNano: pending.timeUnixNano });
        } else {
          rejectedEvents += 1;
        }
      }

      candidateEvents.sort((a, b) => compareTimeUnixNano(a.timeUnixNano, b.timeUnixNano));
      events.push(...candidateEvents);
    }

    return {
      events,
      unpairedToolUses,
      orphanToolResults,
      sessionId,
      malformedLines,
      skippedLines,
      rejectedEvents,
    };
  },
};

import type { Event } from '../../schema/events.js';

/**
 * The Transcript parser interface (SPEC.md:594), one `TranscriptParser` per
 * Agent. `ParsedEvent` omits the Event name on purpose: naming a replayed
 * Event is the `replayer` ticket's job, not this one (see
 * `src/events/event-names.ts`). `project` is
 * a required input to `parse`, not derived inside a parser, because the
 * encoded directory name a Transcript path carries cannot be decoded back
 * to an absolute path without ambiguity when a directory name itself
 * contains a hyphen. `projectFromProjectPath` instead applies the
 * `SPEC.md:227` form to a real absolute path, matching
 * `compose/collector/config.yaml:32-35`.
 */

/** One Event this parser produced, paired with its own emission time. */
export interface ParsedEvent {
  event: Event;
  timeUnixNano: string;
}

/** A `tool_use` block with no matching `tool_result` in the same Transcript. */
export interface UnpairedToolUse {
  tool_use_id: string;
  tool: string;
  timeUnixNano: string;
}

/** A `tool_result` block with no matching `tool_use` in the same Transcript. */
export interface OrphanToolResult {
  tool_use_id: string;
  timeUnixNano: string;
}

/** Everything one Transcript parse run produces, never throwing. */
export interface ParseResult {
  events: ParsedEvent[];
  unpairedToolUses: UnpairedToolUse[];
  orphanToolResults: OrphanToolResult[];
  sessionId: string | undefined;
  malformedLines: number;
  skippedLines: number;
  rejectedEvents: number;
}

/** The lines of one Transcript file, plus the Project this parse run is for. */
export interface TranscriptParseInput {
  lines: readonly string[];
  project: string;
}

/** One Agent's Transcript parser. Pure: no `node:*` import, ever. */
export interface TranscriptParser {
  readonly agent: string;
  parse(input: TranscriptParseInput): ParseResult;
}

/** Matches `compose/collector/config.yaml:79-80`: a tool named `mcp__<rest>` is an MCP call. */
const MCP_TOOL_PREFIX = 'mcp__';
/**
 * Matches an `mcp__<server>__<tool>` tool name, capturing `<server>`: at
 * least one character after the prefix, up to the next `__`. Anchoring the
 * server capture this way folds the "has no second `__`" and the "empty
 * server part" cases into the same no-match outcome as "not an MCP tool at
 * all", one conditional instead of the three `toolTypeOf`'s own prefix check
 * already covers plus two more.
 */
const MCP_TOOL_PATTERN = /^mcp__(.+?)__/;

/** Classifies a `tool` name as an MCP-server call or a native tool call. */
export function toolTypeOf(tool: string): 'mcp' | 'native' {
  return tool.startsWith(MCP_TOOL_PREFIX) ? 'mcp' : 'native';
}

/** Extracts the MCP server name from a `mcp__<server>__<tool>` tool name. */
export function mcpServerOf(tool: string): string | undefined {
  return MCP_TOOL_PATTERN.exec(tool)?.[1];
}

/** Converts a Transcript ISO-8601 timestamp to a nanosecond epoch string. */
export function toUnixNano(isoTimestamp: string): string | undefined {
  const milliseconds = Date.parse(isoTimestamp);
  if (Number.isNaN(milliseconds)) {
    return undefined;
  }

  return (BigInt(milliseconds) * 1_000_000n).toString();
}

/** The UTF-8 byte length of `text`, as `prompt_length` and `result_bytes` need. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Applies the `SPEC.md:227` project form to a real absolute path. */
export function projectFromProjectPath(
  projectPath: string,
  sha256Hex: (value: string) => string,
): string {
  // Matches the Collector's own `replace_pattern(..., "^.*/", "")`: strip up
  // to and including the final `/`, leaving the whole string unchanged when
  // there is none.
  const basename = projectPath.replace(/^.*\//, '');
  const hashPrefix = sha256Hex(projectPath).slice(0, 8);

  return `${basename}-${hashPrefix}`;
}

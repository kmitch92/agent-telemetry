import type { Event } from '../schema/index.js';

/**
 * Pure folds over an ordered list of Events: per-Session totals and
 * per-Run aggregates. No Node built-in import, no file or network access:
 * reading the `events` array and shaping the result only.
 */

/**
 * Per-Session totals folded from an ordered list of Events. Mirrors the
 * nullable columns of the `sessions` table (src/schema/session.ts) minus
 * the DuckDB-only bookkeeping fields such as timestamps and `closed`.
 */
export interface SessionTotals {
  session_id: string;
  agent: string;
  project: string;
  run_id: string | null;
  task: string | null;
  variant: string | null;
  model_calls: number;
  tool_calls: number;
  mcp_server_calls: number;
  prompts: number;
  api_errors: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
}

function createSessionTotals(event: Event): SessionTotals {
  return {
    session_id: event.session_id,
    agent: event.agent,
    project: event.project,
    run_id: null,
    task: null,
    variant: null,
    model_calls: 0,
    tool_calls: 0,
    mcp_server_calls: 0,
    prompts: 0,
    api_errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: null,
  };
}

/** Keeps the first non-absent value seen for a resource key, per Session. */
function firstNonAbsent(current: string | null, next: string | undefined): string | null {
  return current ?? next ?? null;
}

/**
 * Adds one Event's contribution to a Session's running totals, returning a
 * fresh object. A `run_end` Event carries its own `turns` and token fields
 * (src/schema/events.ts:123-137), but those are the Runner's aggregate for
 * the whole Run, not this Event's own model usage, so only `model_call`
 * Events feed the token and cost sums here.
 */
function applySessionEvent(totals: SessionTotals, event: Event): SessionTotals {
  const next: SessionTotals = {
    ...totals,
    run_id: firstNonAbsent(totals.run_id, event.run_id),
    task: firstNonAbsent(totals.task, event.task),
    variant: firstNonAbsent(totals.variant, event.variant),
  };

  switch (event.kind) {
    case 'model_call':
      next.model_calls += 1;
      next.input_tokens += event.input_tokens ?? 0;
      next.output_tokens += event.output_tokens ?? 0;
      next.cache_read_tokens += event.cache_read_tokens ?? 0;
      next.cache_write_tokens += event.cache_write_tokens ?? 0;
      next.reasoning_tokens += event.reasoning_tokens ?? 0;
      if (event.cost_usd !== undefined) {
        next.cost_usd = (next.cost_usd ?? 0) + event.cost_usd;
      }
      return next;
    case 'tool_call':
      next.tool_calls += 1;
      return next;
    case 'mcp_server_call':
      next.mcp_server_calls += 1;
      return next;
    case 'prompt':
      next.prompts += 1;
      return next;
    case 'api_error':
      next.api_errors += 1;
      return next;
    case 'run_start':
    case 'run_end':
      return next;
  }
}

/**
 * Folds `events` into one row per `session_id`, ordered by that Session's
 * first appearance in `events`. Pure: never mutates `events`, and returns a
 * new array on every call.
 */
export function foldSessionTotals(events: readonly Event[]): SessionTotals[] {
  const order: string[] = [];
  const totalsBySessionId = new Map<string, SessionTotals>();

  for (const event of events) {
    const existing = totalsBySessionId.get(event.session_id);
    if (existing === undefined) {
      order.push(event.session_id);
      totalsBySessionId.set(event.session_id, applySessionEvent(createSessionTotals(event), event));
    } else {
      totalsBySessionId.set(event.session_id, applySessionEvent(existing, event));
    }
  }

  return order.map((sessionId) => {
    const totals = totalsBySessionId.get(sessionId);
    if (totals === undefined) {
      throw new Error(`fold: missing totals for session_id ${sessionId}`);
    }
    return totals;
  });
}

/**
 * Per-Run aggregate used for `runner.run_end` (SPEC.md's Run lifecycle,
 * step 9) and for `pnpm report`. Computed from the Events of one `run_id`,
 * independent of Session boundaries.
 */
export interface RunAggregate {
  turns: number;
  tool_calls: number;
  mcp_server_calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_hits: number;
  expected_tools_hit: boolean;
}

/**
 * Returns a new array of the Events whose `run_id` equals `runId`. An
 * Event with no `run_id` never matches.
 */
export function filterByRunId(events: readonly Event[], runId: string): Event[] {
  return events.filter((event) => event.run_id === runId);
}

/**
 * Folds the Events of one Run into the aggregate SPEC.md's Run lifecycle
 * step 9 describes: `turns` is the count of `model_call`, with token sums
 * over the same filtered `model_call` Events; `cache_hits` counts
 * `mcp_server_call` Events whose `mcp_server.cache` is `'hit'`;
 * `expected_tools_hit` looks only at the first `tool_call`, in input
 * order. A Run's own `run_end` Event reports the Runner's aggregate, not a
 * fresh `model_call`, so it is excluded from the token sums for the same
 * reason `foldSessionTotals` excludes it.
 */
export function foldRunAggregate(
  events: readonly Event[],
  options: { runId: string; expectedTools: readonly string[] },
): RunAggregate {
  const filtered = filterByRunId(events, options.runId);

  let turns = 0;
  let toolCalls = 0;
  let mcpServerCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheHits = 0;
  let firstTool: string | null = null;

  for (const event of filtered) {
    switch (event.kind) {
      case 'model_call':
        turns += 1;
        inputTokens += event.input_tokens ?? 0;
        outputTokens += event.output_tokens ?? 0;
        cacheReadTokens += event.cache_read_tokens ?? 0;
        break;
      case 'tool_call':
        toolCalls += 1;
        if (firstTool === null) {
          firstTool = event.tool;
        }
        break;
      case 'mcp_server_call':
        mcpServerCalls += 1;
        if (event['mcp_server.cache'] === 'hit') {
          cacheHits += 1;
        }
        break;
      case 'prompt':
      case 'api_error':
      case 'run_start':
      case 'run_end':
        break;
    }
  }

  const expectedToolsHit = firstTool !== null && options.expectedTools.includes(firstTool);

  return {
    turns,
    tool_calls: toolCalls,
    mcp_server_calls: mcpServerCalls,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_hits: cacheHits,
    expected_tools_hit: expectedToolsHit,
  };
}

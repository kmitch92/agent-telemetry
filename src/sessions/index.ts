import { foldSessionTotals } from '../events/fold.js';
import type { Event } from '../schema/index.js';
import type { SessionRow } from '../schema/session.js';

/**
 * The Session index's pure core (SPEC.md's "Session identity" section). No
 * `node:*` import at all: folding, formatting and filtering only. The thin
 * DuckDB writer lives in `./store.ts`; the command line lives in `./cli.ts`.
 */

/** SPEC.md's Session boundary rule: the default idle window, in minutes. */
export const SESSION_IDLE_MINUTES = 30;

/** `project_path` for a Session whose project has no known local path. */
export const UNKNOWN_PROJECT_PATH = 'unknown';

/** One Event plus the two facts only the reader of an Events file can supply. */
export interface SessionEventRecord {
  event: Event;
  /** Event time, milliseconds since the Unix epoch. */
  at: number;
  /** True only when this system synthesised `event.session_id`. */
  synthetic_session_id: boolean;
}

export interface FoldSessionsOptions {
  now: number;
  projectPaths: ReadonlyMap<string, string>;
  idleMinutes?: number;
}

/** One `session_id`'s records, kept in input order. */
interface SessionGroup {
  sessionId: string;
  events: Event[];
  ats: number[];
  syntheticSessionId: boolean;
}

/**
 * Groups `records` by `event.session_id` alone. SPEC.md's Separation rule
 * requires the key to be the identifier, never the directory, so two
 * concurrent Sessions in one project stay two groups. Never mutates
 * `records`, any record, or any record's `event`.
 */
function groupBySessionId(records: readonly SessionEventRecord[]): SessionGroup[] {
  const order: string[] = [];
  const groups = new Map<string, SessionGroup>();

  for (const record of records) {
    const sessionId = record.event.session_id;
    const existing = groups.get(sessionId);

    if (existing === undefined) {
      order.push(sessionId);
      groups.set(sessionId, {
        sessionId,
        events: [record.event],
        ats: [record.at],
        syntheticSessionId: record.synthetic_session_id,
      });
    } else {
      existing.events.push(record.event);
      existing.ats.push(record.at);
      if (record.synthetic_session_id) {
        existing.syntheticSessionId = true;
      }
    }
  }

  return order.map((sessionId) => {
    const group = groups.get(sessionId);
    if (group === undefined) {
      throw new Error(`sessions: missing group for session_id ${sessionId}`);
    }
    return group;
  });
}

function minOf(values: readonly number[]): number {
  return values.reduce((min, value) => (value < min ? value : min));
}

function maxOf(values: readonly number[]): number {
  return values.reduce((max, value) => (value > max ? value : max));
}

function rowFromGroup(group: SessionGroup, options: FoldSessionsOptions): SessionRow {
  const totals = foldSessionTotals(group.events)[0];
  if (totals === undefined) {
    throw new Error(`sessions: foldSessionTotals produced no totals for ${group.sessionId}`);
  }

  const minAt = minOf(group.ats);
  const maxAt = maxOf(group.ats);
  const idleMinutes = options.idleMinutes ?? SESSION_IDLE_MINUTES;
  const projectPath = options.projectPaths.get(totals.project) ?? UNKNOWN_PROJECT_PATH;

  // Every total here is recomputed from every Event of the group on each
  // call, so a late Event automatically reopens a Session and refreshes its
  // summary: SPEC.md's Session boundary rule, satisfied by recomputation
  // rather than by mutating a stored row.
  const closed = options.now - maxAt >= idleMinutes * 60_000;

  return {
    session_id: totals.session_id,
    agent: totals.agent,
    project: totals.project,
    project_path: projectPath,
    started_at: new Date(minAt).toISOString(),
    last_event_at: new Date(maxAt).toISOString(),
    closed,
    synthetic_session_id: group.syntheticSessionId,
    model_calls: totals.model_calls,
    tool_calls: totals.tool_calls,
    mcp_server_calls: totals.mcp_server_calls,
    prompts: totals.prompts,
    api_errors: totals.api_errors,
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cache_read_tokens: totals.cache_read_tokens,
    cache_write_tokens: totals.cache_write_tokens,
    reasoning_tokens: totals.reasoning_tokens,
    cost_usd: totals.cost_usd,
    wall_ms: maxAt - minAt,
    run_id: totals.run_id,
    task: totals.task,
    variant: totals.variant,
  };
}

/**
 * Folds `records` into one row per `session_id`, sorted `last_event_at`
 * descending, ties broken by `session_id` ascending. Pure: returns a new
 * array on every call, and never mutates `records` or any record.
 */
export function foldSessions(
  records: readonly SessionEventRecord[],
  options: FoldSessionsOptions,
): SessionRow[] {
  const rows = groupBySessionId(records).map((group) => rowFromGroup(group, options));

  return [...rows].sort((a, b) => {
    if (a.last_event_at !== b.last_event_at) {
      return a.last_event_at > b.last_event_at ? -1 : 1;
    }
    if (a.session_id === b.session_id) {
      return 0;
    }
    return a.session_id < b.session_id ? -1 : 1;
  });
}

const UNIX_NANO_PATTERN = /^[0-9]+$/;

/**
 * Converts an OTLP `timeUnixNano` string to milliseconds since the Unix
 * epoch, or `undefined` when the string cannot be placed in time. Never
 * calls `Number(value)` on the nanosecond string: a 19-digit value exceeds
 * `Number.MAX_SAFE_INTEGER` and would lose precision before the division
 * ever happened, so the conversion goes through `BigInt` instead.
 */
export function millisFromUnixNano(timeUnixNano: string): number | undefined {
  if (!UNIX_NANO_PATTERN.test(timeUnixNano)) {
    return undefined;
  }

  const millis = BigInt(timeUnixNano) / 1_000_000n;
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }

  return Number(millis);
}

/**
 * Synthesises a Session identifier for an Agent that emits none (SPEC.md's
 * Fallback rule). The `synthetic:` prefix and the colon separators make this
 * value impossible to mistake for a real Claude Code session identifier,
 * which is a hyphenated UUID (8-4-4-4-12 hex groups).
 */
export function syntheticSessionId(input: { agent: string; project: string; pid: number }): string {
  return `synthetic:${input.agent}:${input.project}:pid-${String(input.pid)}`;
}

const RELATIVE_SINCE_PATTERN = /^([0-9]+)([mhd])$/;
const RELATIVE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * Parses `--since`: a relative span (`30m`, `2h`, `1d`) measured back from
 * `nowMs`, or an ISO 8601 instant. Returns `undefined` for anything else.
 */
export function parseSince(value: string, nowMs: number): number | undefined {
  const relativeMatch = RELATIVE_SINCE_PATTERN.exec(value);
  if (relativeMatch !== null) {
    const amountText = relativeMatch[1];
    const unitText = relativeMatch[2];
    if (amountText === undefined || unitText === undefined) {
      return undefined;
    }
    if (unitText !== 'm' && unitText !== 'h' && unitText !== 'd') {
      return undefined;
    }
    return nowMs - Number(amountText) * RELATIVE_UNIT_MS[unitText];
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Keeps only the rows matching every given filter; an absent filter matches everything. */
export function filterSessionRows(
  rows: readonly SessionRow[],
  filters: { agent?: string; project?: string; sinceMs?: number },
): SessionRow[] {
  return rows.filter((row) => {
    if (filters.agent !== undefined && row.agent !== filters.agent) {
      return false;
    }
    if (filters.project !== undefined && row.project !== filters.project) {
      return false;
    }
    if (filters.sinceMs !== undefined && Date.parse(row.last_event_at) < filters.sinceMs) {
      return false;
    }
    return true;
  });
}

const TABLE_COLUMNS = [
  'session_id',
  'agent',
  'project',
  'started_at',
  'last_event_at',
  'closed',
  'model_calls',
  'tool_calls',
  'mcp_server_calls',
  'input_tokens',
  'output_tokens',
  'cost_usd',
] as const;

type TableColumn = (typeof TABLE_COLUMNS)[number];

function cellValue(row: SessionRow, column: TableColumn): string {
  switch (column) {
    case 'session_id':
      return row.session_id;
    case 'agent':
      return row.agent;
    case 'project':
      return row.project;
    case 'started_at':
      return row.started_at;
    case 'last_event_at':
      return row.last_event_at;
    case 'closed':
      return String(row.closed);
    case 'model_calls':
      return String(row.model_calls);
    case 'tool_calls':
      return String(row.tool_calls);
    case 'mcp_server_calls':
      return String(row.mcp_server_calls);
    case 'input_tokens':
      return String(row.input_tokens);
    case 'output_tokens':
      return String(row.output_tokens);
    case 'cost_usd':
      return row.cost_usd === null ? '-' : row.cost_usd.toFixed(4);
  }
}

/**
 * Renders `rows` as a fixed-width table: one header line naming every
 * column in `TABLE_COLUMNS`, then one line per row, columns padded to their
 * widest cell and joined with two spaces. `'no sessions'` for an empty
 * array. A null `cost_usd` prints as `-`.
 */
export function formatSessionsTable(rows: readonly SessionRow[]): string {
  if (rows.length === 0) {
    return 'no sessions';
  }

  const grid: string[][] = [
    [...TABLE_COLUMNS],
    ...rows.map((row) => TABLE_COLUMNS.map((column) => cellValue(row, column))),
  ];

  const widths = TABLE_COLUMNS.map((_, columnIndex) =>
    Math.max(
      ...grid.map((line) => {
        const cell = line[columnIndex];
        return cell === undefined ? 0 : cell.length;
      }),
    ),
  );

  return grid
    .map((line) =>
      line
        .map((cell, columnIndex) => {
          const width = widths[columnIndex];
          return cell.padEnd(width ?? 0);
        })
        .join('  '),
    )
    .join('\n');
}

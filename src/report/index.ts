import type { Event } from '../schema/index.js';
import type { ReportRow } from '../schema/report.js';

/**
 * The Report's pure core (SPEC.md's Report section). No `node:*` import at
 * all: filtering tool_call Events down to a duration and formatting a table
 * only. The thin DuckDB writer lives in `./store.ts`; the command line lives
 * in `./cli.ts`.
 */

export interface ToolCallDuration {
  run_id: string;
  duration_ms: number;
}

/**
 * Keeps only `tool_call` Events that carry both a `run_id` and a
 * `duration_ms`, the two fields `queryReport` needs to compute
 * `p95_tool_ms` per Task x Variant group.
 */
export function toolCallDurations(events: readonly Event[]): ToolCallDuration[] {
  const result: ToolCallDuration[] = [];

  for (const event of events) {
    if (event.kind !== 'tool_call') {
      continue;
    }
    if (event.run_id === undefined || event.duration_ms === undefined) {
      continue;
    }
    result.push({ run_id: event.run_id, duration_ms: event.duration_ms });
  }

  return result;
}

/**
 * A temp table holding the Report's Run-scoped tool call durations, built
 * fresh from `toolCallDurations` on every `queryReport` call, never
 * persisted between calls.
 */
export const TOOL_CALLS_TABLE_SQL = `
CREATE TEMP TABLE report_tool_calls (run_id VARCHAR, duration_ms BIGINT)
`;

/**
 * The Report query (SPEC.md's Report section). `adhoc` always returns
 * exactly one row, so an empty `runs` table still yields one row carrying
 * `task IS NULL` plus the ad hoc Session count, and the empty case needs no
 * second query. `tool_stats` is aggregated separately and joined back by
 * (task, variant), because joining tool rows into `filtered` would multiply
 * Run rows and corrupt every median.
 */
export const REPORT_SQL = `
WITH filtered AS (
  SELECT * FROM runs
  WHERE CAST($task AS VARCHAR) IS NULL OR task = CAST($task AS VARCHAR)
),
run_stats AS (
  SELECT task, variant,
         count(*) AS n,
         avg(CASE WHEN pass THEN 1.0 ELSE 0.0 END) AS pass_rate,
         median(turns) AS median_turns,
         median(input_tokens_per_turn) AS median_input_tokens_per_turn,
         median(wall_ms) AS median_wall_ms
  FROM filtered GROUP BY task, variant
),
tool_stats AS (
  SELECT f.task, f.variant, quantile_cont(t.duration_ms, 0.95) AS p95_tool_ms
  FROM filtered AS f
  JOIN report_tool_calls AS t ON t.run_id = f.run_id
  GROUP BY f.task, f.variant
),
adhoc AS (
  SELECT count(*) AS adhoc_sessions FROM sessions WHERE run_id IS NULL
)
SELECT r.task, r.variant, r.n, r.pass_rate, r.median_turns,
       r.median_input_tokens_per_turn, r.median_wall_ms,
       t.p95_tool_ms, a.adhoc_sessions
FROM adhoc AS a
LEFT JOIN run_stats AS r ON TRUE
LEFT JOIN tool_stats AS t ON t.task = r.task AND t.variant = r.variant
ORDER BY r.task, r.variant
`;

const TABLE_COLUMNS = [
  'task',
  'variant',
  'n',
  'pass_rate',
  'median_turns',
  'median_input_tokens_per_turn',
  'median_wall_ms',
  'p95_tool_ms',
] as const;

type TableColumn = (typeof TABLE_COLUMNS)[number];

function cellValue(row: ReportRow, column: TableColumn): string {
  switch (column) {
    case 'task':
      return row.task;
    case 'variant':
      return row.variant;
    case 'n':
      return String(row.n);
    case 'pass_rate':
      return row.pass_rate.toFixed(4);
    case 'median_turns':
      return String(row.median_turns);
    case 'median_input_tokens_per_turn':
      return String(row.median_input_tokens_per_turn);
    case 'median_wall_ms':
      return String(row.median_wall_ms);
    case 'p95_tool_ms':
      // Rounds to one decimal place for display only: DuckDB's quantile_cont
      // interpolates in IEEE 754 floating point, so the stored value can
      // carry a tail such as 7609.999999999997. The --json path prints
      // `row.p95_tool_ms` itself, so the exact double survives there.
      return row.p95_tool_ms === null ? '-' : row.p95_tool_ms.toFixed(1);
  }
}

/**
 * Renders `rows` as a fixed-width table: one header line naming every
 * column in `TABLE_COLUMNS`, then one line per row, columns padded to their
 * widest cell and joined with two spaces, following
 * `formatSessionsTable`'s style. `'no Runs recorded'` for an empty array. A
 * null `p95_tool_ms` prints as `-`. The returned string always ends with the
 * line `ad hoc Sessions (no run_id): <adhocSessions>` and no trailing
 * newline after it.
 */
export function formatReportTable(rows: readonly ReportRow[], adhocSessions: number): string {
  const adhocLine = `ad hoc Sessions (no run_id): ${String(adhocSessions)}`;

  if (rows.length === 0) {
    return `no Runs recorded\n${adhocLine}`;
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

  const table = grid
    .map((line) =>
      line
        .map((cell, columnIndex) => {
          const width = widths[columnIndex];
          return cell.padEnd(width ?? 0);
        })
        .join('  '),
    )
    .join('\n');

  return `${table}\n${adhocLine}`;
}

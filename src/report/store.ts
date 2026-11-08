import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api';
import { ReportRowSchema, type ReportOutput, type ReportRow } from '../schema/report.js';
import {
  CREATE_TABLE_SQL as CREATE_RUNS_TABLE_SQL,
  DEFAULT_RESULTS_PATH,
} from '../runner/store.js';
import { CREATE_TABLE_SQL as CREATE_SESSIONS_TABLE_SQL } from '../sessions/store.js';
import { REPORT_SQL, TOOL_CALLS_TABLE_SQL, type ToolCallDuration } from './index.js';

/**
 * The only module touching DuckDB for the Report (SPEC.md's Report
 * section). The pure core, including `REPORT_SQL` itself, stays in
 * `./index.ts`; this module runs it against `results.duckdb`.
 */

async function withConnection<T>(
  path: string,
  callback: (connection: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    await connection.run(CREATE_RUNS_TABLE_SQL);
    await connection.run(CREATE_SESSIONS_TABLE_SQL);
    return await callback(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function field(row: Record<string, JS>, column: string): JS {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`report: column ${column} missing from row`);
  }
  return value;
}

function asString(value: JS, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(`report: column ${column} is not a string`);
  }
  return value;
}

function asNumber(value: JS, column: string): number {
  if (typeof value !== 'number') {
    throw new Error(`report: column ${column} is not a number`);
  }
  return value;
}

function asNullableNumber(value: JS, column: string): number | null {
  return value === null ? null : asNumber(value, column);
}

/**
 * DuckDB's node bindings return a BIGINT column as a JS `bigint`. Converts
 * it to the `number` `ReportRowSchema` expects, throwing a clear error
 * naming the column rather than silently rounding when the value exceeds
 * `Number.MAX_SAFE_INTEGER`.
 */
function asCount(value: JS, column: string): number {
  if (typeof value !== 'bigint') {
    throw new Error(`report: column ${column} is not a bigint`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`report: column ${column} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function parseReportRow(row: Record<string, JS>): ReportRow {
  const candidate = {
    task: asString(field(row, 'task'), 'task'),
    variant: asString(field(row, 'variant'), 'variant'),
    n: asCount(field(row, 'n'), 'n'),
    pass_rate: asNumber(field(row, 'pass_rate'), 'pass_rate'),
    median_turns: asNumber(field(row, 'median_turns'), 'median_turns'),
    median_input_tokens_per_turn: asNumber(
      field(row, 'median_input_tokens_per_turn'),
      'median_input_tokens_per_turn',
    ),
    median_wall_ms: asNumber(field(row, 'median_wall_ms'), 'median_wall_ms'),
    p95_tool_ms: asNullableNumber(field(row, 'p95_tool_ms'), 'p95_tool_ms'),
  };

  return ReportRowSchema.parse(candidate);
}

async function insertToolCalls(
  connection: DuckDBConnection,
  toolCalls: readonly ToolCallDuration[],
): Promise<void> {
  await connection.run(TOOL_CALLS_TABLE_SQL);
  for (const toolCall of toolCalls) {
    await connection.run(
      'INSERT INTO report_tool_calls (run_id, duration_ms) VALUES ($run_id, $duration_ms)',
      {
        run_id: toolCall.run_id,
        duration_ms: toolCall.duration_ms,
      },
    );
  }
}

/**
 * Runs the Report query (SPEC.md's Report section) against
 * `results.duckdb`. Both the `runs` and `sessions` tables are created, so a
 * fresh database with neither table works. A returned row whose `task` is
 * null means no Run matched: this resolves to `rows: []` together with the
 * `adhoc_sessions` value from that same row.
 */
export async function queryReport(options: {
  toolCalls: readonly ToolCallDuration[];
  task?: string;
  path?: string;
}): Promise<ReportOutput> {
  const path = options.path ?? DEFAULT_RESULTS_PATH;

  return withConnection(path, async (connection) => {
    await insertToolCalls(connection, options.toolCalls);

    const params: Record<string, DuckDBValue> = {
      task: options.task ?? null,
    };

    const reader = await connection.runAndReadAll(REPORT_SQL, params);
    const rawRows = reader.getRowObjectsJS();

    const first = rawRows[0];
    if (rawRows.length === 1 && first !== undefined && first['task'] === null) {
      return {
        rows: [],
        adhoc_sessions: asCount(field(first, 'adhoc_sessions'), 'adhoc_sessions'),
      };
    }

    const rows = rawRows.map((row) => parseReportRow(row));
    const adhocSource = rawRows[0];
    const adhoc_sessions =
      adhocSource === undefined
        ? 0
        : asCount(field(adhocSource, 'adhoc_sessions'), 'adhoc_sessions');

    return { rows, adhoc_sessions };
  });
}

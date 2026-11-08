import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api';
import { ResultsRowSchema, type ResultsRow } from '../schema/index.js';

/**
 * The only module touching DuckDB for the Runner's Results row (SPEC.md's
 * Runner section). This module upserts and reads rows of the `runs` table
 * in `results.duckdb`; the Runner's pure core stays in `./index.ts`.
 */

export const DEFAULT_RESULTS_PATH = 'results.duckdb';

/**
 * Runs on every open so the command works on a fresh machine with no
 * existing `results.duckdb` file.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS runs (
  run_id VARCHAR PRIMARY KEY,
  started_at VARCHAR,
  task VARCHAR,
  agent VARCHAR,
  variant VARCHAR,
  cache VARCHAR,
  rep BIGINT,
  pass BOOLEAN,
  exit_code BIGINT,
  timed_out BOOLEAN,
  wall_ms BIGINT,
  turns BIGINT,
  tool_calls BIGINT,
  mcp_server_calls BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  input_tokens_per_turn DOUBLE,
  cost_usd DOUBLE,
  expected_tools_hit BOOLEAN,
  cache_hits BIGINT,
  checker_output VARCHAR
)
`;

const UPSERT_SQL = `
INSERT INTO runs (
  run_id, started_at, task, agent, variant, cache, rep, pass, exit_code,
  timed_out, wall_ms, turns, tool_calls, mcp_server_calls, input_tokens,
  output_tokens, cache_read_tokens, input_tokens_per_turn, cost_usd,
  expected_tools_hit, cache_hits, checker_output
) VALUES (
  $run_id, $started_at, $task, $agent, $variant, $cache, $rep, $pass, $exit_code,
  $timed_out, $wall_ms, $turns, $tool_calls, $mcp_server_calls, $input_tokens,
  $output_tokens, $cache_read_tokens, $input_tokens_per_turn, $cost_usd,
  $expected_tools_hit, $cache_hits, $checker_output
)
ON CONFLICT (run_id) DO UPDATE SET
  started_at = excluded.started_at,
  task = excluded.task,
  agent = excluded.agent,
  variant = excluded.variant,
  cache = excluded.cache,
  rep = excluded.rep,
  pass = excluded.pass,
  exit_code = excluded.exit_code,
  timed_out = excluded.timed_out,
  wall_ms = excluded.wall_ms,
  turns = excluded.turns,
  tool_calls = excluded.tool_calls,
  mcp_server_calls = excluded.mcp_server_calls,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  input_tokens_per_turn = excluded.input_tokens_per_turn,
  cost_usd = excluded.cost_usd,
  expected_tools_hit = excluded.expected_tools_hit,
  cache_hits = excluded.cache_hits,
  checker_output = excluded.checker_output
`;

async function withConnection<T>(
  path: string,
  callback: (connection: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  try {
    await connection.run(CREATE_TABLE_SQL);
    return await callback(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function valuesForRow(row: ResultsRow): Record<string, DuckDBValue> {
  return {
    run_id: row.run_id,
    started_at: row.started_at,
    task: row.task,
    agent: row.agent,
    variant: row.variant,
    cache: row.cache,
    rep: row.rep,
    pass: row.pass,
    exit_code: row.exit_code,
    timed_out: row.timed_out,
    wall_ms: row.wall_ms,
    turns: row.turns,
    tool_calls: row.tool_calls,
    mcp_server_calls: row.mcp_server_calls,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    input_tokens_per_turn: row.input_tokens_per_turn,
    cost_usd: row.cost_usd,
    expected_tools_hit: row.expected_tools_hit,
    cache_hits: row.cache_hits,
    checker_output: row.checker_output,
  };
}

/**
 * Upserts one row per Run into `results.duckdb`, table `runs`. The primary
 * key plus the `ON CONFLICT ... DO UPDATE` clause mean a re-run of the same
 * `run_id` replaces the row rather than duplicating it. Resolves to the
 * number of rows written.
 */
export async function upsertRuns(
  rows: readonly ResultsRow[],
  path: string = DEFAULT_RESULTS_PATH,
): Promise<number> {
  return withConnection(path, async (connection) => {
    for (const row of rows) {
      await connection.run(UPSERT_SQL, valuesForRow(row));
    }
    return rows.length;
  });
}

function field(row: Record<string, JS>, column: string): JS {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`runs: column ${column} missing from row`);
  }
  return value;
}

function asString(value: JS, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(`runs: column ${column} is not a string`);
  }
  return value;
}

function asBoolean(value: JS, column: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`runs: column ${column} is not a boolean`);
  }
  return value;
}

/**
 * DuckDB's node bindings return a BIGINT column as a JS `bigint`. Converts
 * it to the `number` `ResultsRowSchema` expects, throwing a clear error
 * naming the column rather than silently rounding when the value exceeds
 * `Number.MAX_SAFE_INTEGER`.
 */
function asCount(value: JS, column: string): number {
  if (typeof value !== 'bigint') {
    throw new Error(`runs: column ${column} is not a bigint`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`runs: column ${column} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

/** As `asCount`, but a `null` value (a nullable BIGINT column) stays `null`. */
function asNullableCount(value: JS, column: string): number | null {
  return value === null ? null : asCount(value, column);
}

function asNumber(value: JS, column: string): number {
  if (typeof value !== 'number') {
    throw new Error(`runs: column ${column} is not a number`);
  }
  return value;
}

/** As `asNumber`, but a `null` value (a nullable DOUBLE column) stays `null`. */
function asNullableNumber(value: JS, column: string): number | null {
  return value === null ? null : asNumber(value, column);
}

function parseRow(row: Record<string, JS>): ResultsRow {
  const candidate = {
    run_id: asString(field(row, 'run_id'), 'run_id'),
    started_at: asString(field(row, 'started_at'), 'started_at'),
    task: asString(field(row, 'task'), 'task'),
    agent: asString(field(row, 'agent'), 'agent'),
    variant: asString(field(row, 'variant'), 'variant'),
    cache: asString(field(row, 'cache'), 'cache'),
    rep: asCount(field(row, 'rep'), 'rep'),
    pass: asBoolean(field(row, 'pass'), 'pass'),
    exit_code: asNullableCount(field(row, 'exit_code'), 'exit_code'),
    timed_out: asBoolean(field(row, 'timed_out'), 'timed_out'),
    wall_ms: asCount(field(row, 'wall_ms'), 'wall_ms'),
    turns: asCount(field(row, 'turns'), 'turns'),
    tool_calls: asCount(field(row, 'tool_calls'), 'tool_calls'),
    mcp_server_calls: asCount(field(row, 'mcp_server_calls'), 'mcp_server_calls'),
    input_tokens: asCount(field(row, 'input_tokens'), 'input_tokens'),
    output_tokens: asCount(field(row, 'output_tokens'), 'output_tokens'),
    cache_read_tokens: asCount(field(row, 'cache_read_tokens'), 'cache_read_tokens'),
    input_tokens_per_turn: asNumber(field(row, 'input_tokens_per_turn'), 'input_tokens_per_turn'),
    cost_usd: asNullableNumber(field(row, 'cost_usd'), 'cost_usd'),
    expected_tools_hit: asBoolean(field(row, 'expected_tools_hit'), 'expected_tools_hit'),
    cache_hits: asCount(field(row, 'cache_hits'), 'cache_hits'),
    checker_output: asString(field(row, 'checker_output'), 'checker_output'),
  };

  return ResultsRowSchema.parse(candidate);
}

/**
 * Reads every row of `runs`, newest first, ties broken by `run_id`
 * ascending, each validated against `ResultsRowSchema`. The order comes
 * from the query itself, not a JavaScript sort, so it holds for every
 * caller. `started_at` is stored as an ISO 8601 `VARCHAR`, whose
 * lexicographic order equals its chronological order, so sorting it as a
 * string is correct here.
 */
export async function readRuns(path: string = DEFAULT_RESULTS_PATH): Promise<ResultsRow[]> {
  return withConnection(path, async (connection) => {
    const reader = await connection.runAndReadAll(
      'SELECT * FROM runs ORDER BY started_at DESC, run_id ASC',
    );
    return reader.getRowObjectsJS().map((row) => parseRow(row));
  });
}

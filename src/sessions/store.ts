import { readFile } from 'node:fs/promises';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection, DuckDBValue, JS } from '@duckdb/node-api';
import { z } from 'zod';
import { SessionRowSchema, type SessionRow } from '../schema/session.js';

/**
 * The only module touching DuckDB (SPEC.md's Session index section). The
 * fold stays pure in `./index.ts`; this module upserts Session rows into
 * `results.duckdb` and reads `data/project-paths.json`, both at the edge.
 */

export const DEFAULT_RESULTS_PATH = 'results.duckdb';
export const DEFAULT_PROJECT_PATHS_FILE = 'data/project-paths.json';

/**
 * Runs on every open so the command works on a fresh machine with no
 * existing `results.duckdb` file. The two timestamps are stored as the ISO
 * 8601 `VARCHAR` `SessionRowSchema` already defines, not as a DuckDB
 * `TIMESTAMP`, so no conversion is needed when the row is read back.
 */
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR PRIMARY KEY,
  agent VARCHAR,
  project VARCHAR,
  project_path VARCHAR,
  started_at VARCHAR,
  last_event_at VARCHAR,
  closed BOOLEAN,
  synthetic_session_id BOOLEAN,
  model_calls BIGINT,
  tool_calls BIGINT,
  mcp_server_calls BIGINT,
  prompts BIGINT,
  api_errors BIGINT,
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_write_tokens BIGINT,
  reasoning_tokens BIGINT,
  cost_usd DOUBLE,
  wall_ms BIGINT,
  run_id VARCHAR,
  task VARCHAR,
  variant VARCHAR
)
`;

const UPSERT_SQL = `
INSERT INTO sessions (
  session_id, agent, project, project_path, started_at, last_event_at, closed,
  synthetic_session_id, model_calls, tool_calls, mcp_server_calls, prompts,
  api_errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, cost_usd, wall_ms, run_id, task, variant
) VALUES (
  $session_id, $agent, $project, $project_path, $started_at, $last_event_at, $closed,
  $synthetic_session_id, $model_calls, $tool_calls, $mcp_server_calls, $prompts,
  $api_errors, $input_tokens, $output_tokens, $cache_read_tokens, $cache_write_tokens,
  $reasoning_tokens, $cost_usd, $wall_ms, $run_id, $task, $variant
)
ON CONFLICT (session_id) DO UPDATE SET
  agent = excluded.agent,
  project = excluded.project,
  project_path = excluded.project_path,
  started_at = excluded.started_at,
  last_event_at = excluded.last_event_at,
  closed = excluded.closed,
  synthetic_session_id = excluded.synthetic_session_id,
  model_calls = excluded.model_calls,
  tool_calls = excluded.tool_calls,
  mcp_server_calls = excluded.mcp_server_calls,
  prompts = excluded.prompts,
  api_errors = excluded.api_errors,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  reasoning_tokens = excluded.reasoning_tokens,
  cost_usd = excluded.cost_usd,
  wall_ms = excluded.wall_ms,
  run_id = excluded.run_id,
  task = excluded.task,
  variant = excluded.variant
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

function valuesForRow(row: SessionRow): Record<string, DuckDBValue> {
  return {
    session_id: row.session_id,
    agent: row.agent,
    project: row.project,
    project_path: row.project_path,
    started_at: row.started_at,
    last_event_at: row.last_event_at,
    closed: row.closed,
    synthetic_session_id: row.synthetic_session_id,
    model_calls: row.model_calls,
    tool_calls: row.tool_calls,
    mcp_server_calls: row.mcp_server_calls,
    prompts: row.prompts,
    api_errors: row.api_errors,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    reasoning_tokens: row.reasoning_tokens,
    cost_usd: row.cost_usd,
    wall_ms: row.wall_ms,
    run_id: row.run_id,
    task: row.task,
    variant: row.variant,
  };
}

/**
 * Upserts one row per Session into `results.duckdb`, table `sessions`. The
 * primary key plus the `ON CONFLICT ... DO UPDATE` clause give idempotence:
 * running this twice over the same rows leaves the same table, which is
 * what the Session boundary rule's recomputation needs. Resolves to the
 * number of rows written.
 */
export async function upsertSessions(
  rows: readonly SessionRow[],
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
    throw new Error(`sessions: column ${column} missing from row`);
  }
  return value;
}

function asString(value: JS, column: string): string {
  if (typeof value !== 'string') {
    throw new Error(`sessions: column ${column} is not a string`);
  }
  return value;
}

function asNullableString(value: JS, column: string): string | null {
  return value === null ? null : asString(value, column);
}

function asBoolean(value: JS, column: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`sessions: column ${column} is not a boolean`);
  }
  return value;
}

function asNullableNumber(value: JS, column: string): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw new Error(`sessions: column ${column} is not a number`);
  }
  return value;
}

/**
 * DuckDB's node bindings return a BIGINT column as a JS `bigint`. Converts
 * it to the `number` `SessionRowSchema` expects, throwing a clear error
 * naming the column rather than silently rounding when the value exceeds
 * `Number.MAX_SAFE_INTEGER`.
 */
function asCount(value: JS, column: string): number {
  if (typeof value !== 'bigint') {
    throw new Error(`sessions: column ${column} is not a bigint`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`sessions: column ${column} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(value);
}

function parseRow(row: Record<string, JS>): SessionRow {
  const candidate = {
    session_id: asString(field(row, 'session_id'), 'session_id'),
    agent: asString(field(row, 'agent'), 'agent'),
    project: asString(field(row, 'project'), 'project'),
    project_path: asString(field(row, 'project_path'), 'project_path'),
    started_at: asString(field(row, 'started_at'), 'started_at'),
    last_event_at: asString(field(row, 'last_event_at'), 'last_event_at'),
    closed: asBoolean(field(row, 'closed'), 'closed'),
    synthetic_session_id: asBoolean(field(row, 'synthetic_session_id'), 'synthetic_session_id'),
    model_calls: asCount(field(row, 'model_calls'), 'model_calls'),
    tool_calls: asCount(field(row, 'tool_calls'), 'tool_calls'),
    mcp_server_calls: asCount(field(row, 'mcp_server_calls'), 'mcp_server_calls'),
    prompts: asCount(field(row, 'prompts'), 'prompts'),
    api_errors: asCount(field(row, 'api_errors'), 'api_errors'),
    input_tokens: asCount(field(row, 'input_tokens'), 'input_tokens'),
    output_tokens: asCount(field(row, 'output_tokens'), 'output_tokens'),
    cache_read_tokens: asCount(field(row, 'cache_read_tokens'), 'cache_read_tokens'),
    cache_write_tokens: asCount(field(row, 'cache_write_tokens'), 'cache_write_tokens'),
    reasoning_tokens: asCount(field(row, 'reasoning_tokens'), 'reasoning_tokens'),
    cost_usd: asNullableNumber(field(row, 'cost_usd'), 'cost_usd'),
    wall_ms: asCount(field(row, 'wall_ms'), 'wall_ms'),
    run_id: asNullableString(field(row, 'run_id'), 'run_id'),
    task: asNullableString(field(row, 'task'), 'task'),
    variant: asNullableString(field(row, 'variant'), 'variant'),
  };

  return SessionRowSchema.parse(candidate);
}

/**
 * Reads every row of `sessions`, newest first, ties broken by `session_id`
 * ascending, each validated against `SessionRowSchema`. The order comes from
 * the query itself, not a JavaScript sort, so it holds for every caller.
 * `last_event_at` is stored as an ISO 8601 `VARCHAR`, whose lexicographic
 * order equals its chronological order, so sorting it as a string is
 * correct here.
 */
export async function readSessions(path: string = DEFAULT_RESULTS_PATH): Promise<SessionRow[]> {
  return withConnection(path, async (connection) => {
    const reader = await connection.runAndReadAll(
      'SELECT * FROM sessions ORDER BY last_event_at DESC, session_id ASC',
    );
    return reader.getRowObjectsJS().map((row) => parseRow(row));
  });
}

const ProjectPathsFileSchema = z.record(z.string(), z.string());

/** Minimal shape of a Node error that carries a `code`, used without a cast. */
interface ErrnoLike {
  code?: string;
}

function hasErrorCode(error: unknown): error is ErrnoLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT';
}

/**
 * Reads `{ "<project>": "<absolute path>" }` into a Map. A missing file
 * resolves to an empty Map. Invalid JSON, or a value that is not a string,
 * also resolves to an empty Map, after one line on `process.stderr`.
 */
export async function readProjectPaths(
  path: string = DEFAULT_PROJECT_PATHS_FILE,
): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return new Map();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    process.stderr.write(`agent-telemetry: ${path} is not valid JSON\n`);
    return new Map();
  }

  const result = ProjectPathsFileSchema.safeParse(parsed);
  if (!result.success) {
    process.stderr.write(`agent-telemetry: ${path} does not match the project-path shape\n`);
    return new Map();
  }

  return new Map(Object.entries(result.data));
}

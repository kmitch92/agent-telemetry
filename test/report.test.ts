import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ReportOutputSchema } from '../src/schema/index.js';
import type { Event, ReportRow, ResultsRow, SessionRow } from '../src/schema/index.js';

import { upsertRuns } from '../src/runner/store.js';
import { upsertSessions } from '../src/sessions/store.js';

import {
  REPORT_SQL,
  TOOL_CALLS_TABLE_SQL,
  toolCallDurations,
  formatReportTable,
} from '../src/report/index.js';
import type { ToolCallDuration } from '../src/report/index.js';
import { queryReport } from '../src/report/store.js';

/**
 * Tests for the report feature (SPEC.md's Report section). Nothing under
 * src/report/ exists yet except a .gitkeep; importing these modules is the
 * expected RED failure.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-report-store-'));
  tempDirs.push(dir);
  return join(dir, 'test.duckdb');
}

function makeResultsRow(overrides: Partial<ResultsRow> = {}): ResultsRow {
  return {
    run_id: 'run-report-1',
    started_at: '2026-11-08T00:00:00.000Z',
    task: 'hello',
    agent: 'claude-code',
    variant: 'none',
    cache: 'cold',
    rep: 0,
    pass: true,
    exit_code: 0,
    timed_out: false,
    wall_ms: 1500,
    turns: 2,
    tool_calls: 1,
    mcp_server_calls: 1,
    input_tokens: 40,
    output_tokens: 10,
    cache_read_tokens: 5,
    input_tokens_per_turn: 20,
    cost_usd: 0.2,
    expected_tools_hit: true,
    cache_hits: 1,
    checker_output: 'ok\n',
    ...overrides,
  };
}

function makeSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 'session-report-1',
    agent: 'claude-code',
    project: 'proj-report',
    project_path: '/tmp/proj-report',
    started_at: '2026-11-08T00:00:00.000Z',
    last_event_at: '2026-11-08T00:05:00.000Z',
    closed: true,
    synthetic_session_id: false,
    model_calls: 1,
    tool_calls: 0,
    mcp_server_calls: 0,
    prompts: 0,
    api_errors: 0,
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: 0.01,
    wall_ms: 300_000,
    run_id: null,
    task: null,
    variant: null,
    ...overrides,
  };
}

type ToolCallEventRow = Extract<Event, { kind: 'tool_call' }>;

function toolCallEvent(overrides: Partial<Omit<ToolCallEventRow, 'kind'>>): ToolCallEventRow {
  return {
    kind: 'tool_call',
    agent: 'claude-code',
    session_id: 'session-x',
    project: 'proj-x',
    tool: 'probe_echo',
    success: true,
    tool_type: 'native',
    ...overrides,
  };
}

describe('report module exports', () => {
  it('exposes REPORT_SQL and TOOL_CALLS_TABLE_SQL as non-empty strings', () => {
    expect(typeof REPORT_SQL).toBe('string');
    expect(REPORT_SQL.length).toBeGreaterThan(0);
    expect(typeof TOOL_CALLS_TABLE_SQL).toBe('string');
    expect(TOOL_CALLS_TABLE_SQL.length).toBeGreaterThan(0);
  });
});

describe('toolCallDurations', () => {
  it('keeps only tool_call Events that carry both a run_id and a duration_ms', () => {
    const events: Event[] = [
      toolCallEvent({
        session_id: 'session-1',
        project: 'proj-1',
        run_id: 'run-valid',
        duration_ms: 123,
      }),
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-1',
        project: 'proj-1',
        run_id: 'run-model',
        model: 'claude-opus-5',
        duration_ms: 456,
      },
      toolCallEvent({
        session_id: 'session-1',
        project: 'proj-1',
        duration_ms: 789,
      }),
      toolCallEvent({
        session_id: 'session-1',
        project: 'proj-1',
        run_id: 'run-no-duration',
      }),
    ];

    const result: ToolCallDuration[] = toolCallDurations(events);

    expect(result).toEqual([{ run_id: 'run-valid', duration_ms: 123 }]);
  });
});

describe('queryReport: grouping, n, and pass_rate', () => {
  it('produces the right n and pass_rate per Task x Variant group, ordered by task then variant', async () => {
    const path = await tempDbPath();

    await upsertRuns(
      [
        makeResultsRow({ run_id: 'g2-hello-fs-1', task: 'hello', variant: 'fs', pass: true }),
        makeResultsRow({ run_id: 'g2-hello-none-1', task: 'hello', variant: 'none', pass: true }),
        makeResultsRow({ run_id: 'g2-hello-none-2', task: 'hello', variant: 'none', pass: true }),
        makeResultsRow({ run_id: 'g2-hello-none-3', task: 'hello', variant: 'none', pass: false }),
        makeResultsRow({ run_id: 'g2-world-none-1', task: 'world', variant: 'none', pass: true }),
        makeResultsRow({ run_id: 'g2-world-none-2', task: 'world', variant: 'none', pass: false }),
      ],
      path,
    );

    const result = await queryReport({ toolCalls: [], path });

    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((row: ReportRow) => [row.task, row.variant])).toEqual([
      ['hello', 'fs'],
      ['hello', 'none'],
      ['world', 'none'],
    ]);
    expect(result.rows[0]?.n).toBe(1);
    expect(result.rows[0]?.pass_rate).toBe(1);
    expect(result.rows[1]?.n).toBe(3);
    expect(result.rows[1]?.pass_rate).toBeCloseTo(2 / 3);
    expect(result.rows[2]?.n).toBe(2);
    expect(result.rows[2]?.pass_rate).toBeCloseTo(0.5);
  });
});

describe('queryReport: median_turns', () => {
  it('computes median_turns 2.5 for four Runs with turns 1, 2, 3, 4', async () => {
    const path = await tempDbPath();

    await upsertRuns(
      [
        makeResultsRow({ run_id: 'g3-1', task: 'median-task', variant: 'v1', turns: 1 }),
        makeResultsRow({ run_id: 'g3-2', task: 'median-task', variant: 'v1', turns: 2 }),
        makeResultsRow({ run_id: 'g3-3', task: 'median-task', variant: 'v1', turns: 3 }),
        makeResultsRow({ run_id: 'g3-4', task: 'median-task', variant: 'v1', turns: 4 }),
      ],
      path,
    );

    const result = await queryReport({ toolCalls: [], path });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.median_turns).toBe(2.5);
  });
});

describe('queryReport: p95_tool_ms', () => {
  it("matches DuckDB's quantile_cont(x, 0.95) for a known set, and is null with no tool calls", async () => {
    const path = await tempDbPath();

    await upsertRuns(
      [
        makeResultsRow({ run_id: 'g4-full', task: 'p95-task', variant: 'full' }),
        makeResultsRow({ run_id: 'g4-empty', task: 'p95-task', variant: 'empty' }),
      ],
      path,
    );

    const toolCalls: ToolCallDuration[] = [
      { run_id: 'g4-full', duration_ms: 100 },
      { run_id: 'g4-full', duration_ms: 200 },
      { run_id: 'g4-full', duration_ms: 300 },
      { run_id: 'g4-full', duration_ms: 400 },
      { run_id: 'g4-full', duration_ms: 500 },
    ];

    const result = await queryReport({ toolCalls, path });

    const fullRow = result.rows.find((row: ReportRow) => row.variant === 'full');
    const emptyRow = result.rows.find((row: ReportRow) => row.variant === 'empty');

    // quantile_cont([100,200,300,400,500], 0.95): position = 0.95 * 4 = 3.8,
    // value = 400 + 0.8 * (500 - 400) = 480. The comparison allows six decimal
    // places because IEEE 754 floating point interpolation inside DuckDB can
    // return a value such as 479.99999999999994 instead of the exact 480.
    expect(fullRow?.p95_tool_ms).toBeCloseTo(480, 6);
    expect(emptyRow?.p95_tool_ms).toBeNull();
  });
});

describe('queryReport: task filter', () => {
  it('narrows the output rows to the given task only', async () => {
    const path = await tempDbPath();

    await upsertRuns(
      [
        makeResultsRow({ run_id: 'g5-hello-1', task: 'hello', variant: 'none' }),
        makeResultsRow({ run_id: 'g5-hello-2', task: 'hello', variant: 'none' }),
        makeResultsRow({ run_id: 'g5-world-1', task: 'world', variant: 'none' }),
      ],
      path,
    );

    const result = await queryReport({ toolCalls: [], task: 'hello', path });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.task).toBe('hello');
  });
});

describe('queryReport: adhoc_sessions', () => {
  it('counts Sessions with a null run_id as ad hoc', async () => {
    const path = await tempDbPath();

    await upsertSessions(
      [
        makeSessionRow({ session_id: 'g6-adhoc-1', run_id: null }),
        makeSessionRow({ session_id: 'g6-adhoc-2', run_id: null }),
        makeSessionRow({
          session_id: 'g6-run-1',
          run_id: 'run-g6',
          task: 'hello',
          variant: 'none',
        }),
      ],
      path,
    );

    const result = await queryReport({ toolCalls: [], path });

    expect(result.adhoc_sessions).toBe(2);
  });
});

describe('queryReport: empty database', () => {
  it('returns no rows and zero ad hoc Sessions for a fresh database', async () => {
    const path = await tempDbPath();

    const result = await queryReport({ toolCalls: [], path });

    expect(result).toEqual({ rows: [], adhoc_sessions: 0 });
    expect(formatReportTable(result.rows, result.adhoc_sessions)).toContain('no Runs recorded');
  });
});

describe('formatReportTable', () => {
  it('always ends with the ad hoc Sessions line, for an empty and a non-empty table', () => {
    const emptyTable = formatReportTable([], 0);
    expect(emptyTable).toMatch(/ad hoc Sessions \(no run_id\): 0$/);

    const rows: ReportRow[] = [
      {
        task: 'hello',
        variant: 'none',
        n: 3,
        pass_rate: 2 / 3,
        median_turns: 2,
        median_input_tokens_per_turn: 20,
        median_wall_ms: 1500,
        p95_tool_ms: 480,
      },
    ];
    const filledTable = formatReportTable(rows, 4);
    expect(filledTable).toMatch(/ad hoc Sessions \(no run_id\): 4$/);
  });
});

describe('formatReportTable: p95_tool_ms cell rounding', () => {
  it('rounds the p95_tool_ms cell to one decimal place, and prints "-" for null', () => {
    const rows: ReportRow[] = [
      {
        task: 'hello',
        variant: 'none',
        n: 1,
        pass_rate: 1,
        median_turns: 2,
        median_input_tokens_per_turn: 20,
        median_wall_ms: 1500,
        p95_tool_ms: 7609.999999999997,
      },
      {
        task: 'hello',
        variant: 'fs',
        n: 1,
        pass_rate: 1,
        median_turns: 2,
        median_input_tokens_per_turn: 20,
        median_wall_ms: 1500,
        p95_tool_ms: 84.6,
      },
      {
        task: 'world',
        variant: 'none',
        n: 1,
        pass_rate: 1,
        median_turns: 2,
        median_input_tokens_per_turn: 20,
        median_wall_ms: 1500,
        p95_tool_ms: null,
      },
    ];

    const table = formatReportTable(rows, 0);

    expect(table).toContain('7610.0');
    expect(table).not.toContain('7609.999');
    expect(table).toContain('84.6');
    expect(table).toContain('-');
  });
});

describe('queryReport: output schema', () => {
  it('produces a result that satisfies ReportOutputSchema', async () => {
    const path = await tempDbPath();

    await upsertRuns([makeResultsRow({ run_id: 'g8-1', task: 'hello', variant: 'none' })], path);
    await upsertSessions([makeSessionRow({ session_id: 'g8-session-1', run_id: null })], path);

    const result = await queryReport({ toolCalls: [], path });

    expect(() => ReportOutputSchema.parse(result)).not.toThrow();
  });
});

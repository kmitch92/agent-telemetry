import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { foldSessionTotals } from '../src/events/fold.js';
import type { Event } from '../src/schema/index.js';
import { SessionRowSchema, type SessionRow } from '../src/schema/session.js';
import {
  SESSION_IDLE_MINUTES,
  UNKNOWN_PROJECT_PATH,
  filterSessionRows,
  foldSessions,
  formatSessionsTable,
  millisFromUnixNano,
  parseSince,
  syntheticSessionId,
  type SessionEventRecord,
} from '../src/sessions/index.js';
import {
  DEFAULT_PROJECT_PATHS_FILE,
  DEFAULT_RESULTS_PATH,
  readProjectPaths,
  readSessions,
  upsertSessions,
} from '../src/sessions/store.js';

const BASE = Date.UTC(2026, 10, 8, 0, 0, 0);

function rec(event: Event, at: number, synthetic = false): SessionEventRecord {
  return { event, at, synthetic_session_id: synthetic };
}

function promptEvent(sessionId: string, project: string): Event {
  return {
    kind: 'prompt',
    agent: 'claude-code',
    session_id: sessionId,
    project,
    prompt_length: 12,
  };
}

function modelCallEvent(
  sessionId: string,
  project: string,
  tokens: { input_tokens: number; output_tokens: number; cost_usd?: number },
): Event {
  return {
    kind: 'model_call',
    agent: 'claude-code',
    session_id: sessionId,
    project,
    model: 'claude-opus-5',
    input_tokens: tokens.input_tokens,
    output_tokens: tokens.output_tokens,
    ...(tokens.cost_usd !== undefined ? { cost_usd: tokens.cost_usd } : {}),
  };
}

function toolCallEvent(sessionId: string, project: string): Event {
  return {
    kind: 'tool_call',
    agent: 'claude-code',
    session_id: sessionId,
    project,
    tool: 'probe_echo',
    success: true,
    tool_type: 'native',
  };
}

function makeRow(partial: Partial<SessionRow> = {}): SessionRow {
  return {
    session_id: 'session-x',
    agent: 'claude-code',
    project: 'proj-x',
    project_path: '/tmp/proj-x',
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
    ...partial,
  };
}

describe('foldSessions', () => {
  it('keeps two concurrent Sessions in one project as two rows', () => {
    const records: SessionEventRecord[] = [
      rec(modelCallEvent('session-a', 'proj-x', { input_tokens: 10, output_tokens: 2 }), BASE),
      rec(modelCallEvent('session-b', 'proj-x', { input_tokens: 4, output_tokens: 1 }), BASE + 500),
      rec(promptEvent('session-a', 'proj-x'), BASE + 1000),
      rec(promptEvent('session-b', 'proj-x'), BASE + 1500),
    ];

    const rows = foldSessions(records, {
      now: BASE + 100_000,
      projectPaths: new Map(),
    });

    expect(rows).toHaveLength(2);
    expect(rows.map((row: SessionRow) => row.session_id).sort()).toEqual([
      'session-a',
      'session-b',
    ]);
  });

  it('matches foldSessionTotals per group for counts, tokens and cost', () => {
    const events: Event[] = [
      promptEvent('session-a', 'proj-x'),
      modelCallEvent('session-a', 'proj-x', { input_tokens: 10, output_tokens: 2, cost_usd: 0.5 }),
      toolCallEvent('session-a', 'proj-x'),
    ];
    const expected = foldSessionTotals(events)[0];
    const records = events.map((event, index) => rec(event, BASE + index * 1000));

    const rows = foldSessions(records, { now: BASE + 10_000, projectPaths: new Map() });
    const row = rows.find((candidate: SessionRow) => candidate.session_id === 'session-a');

    expect(row).toBeDefined();
    expect(row?.model_calls).toBe(expected?.model_calls);
    expect(row?.tool_calls).toBe(expected?.tool_calls);
    expect(row?.prompts).toBe(expected?.prompts);
    expect(row?.input_tokens).toBe(expected?.input_tokens);
    expect(row?.output_tokens).toBe(expected?.output_tokens);
    expect(row?.cost_usd).toBe(expected?.cost_usd);
  });

  it('sets project_path from the map, and UNKNOWN_PROJECT_PATH when the project is absent', () => {
    const records: SessionEventRecord[] = [
      rec(promptEvent('session-known', 'proj-x'), BASE),
      rec(promptEvent('session-unknown', 'proj-y'), BASE),
    ];

    const rows = foldSessions(records, {
      now: BASE + 10_000,
      projectPaths: new Map([['proj-x', '/home/dev/proj-x']]),
    });

    const known = rows.find((row: SessionRow) => row.session_id === 'session-known');
    const unknown = rows.find((row: SessionRow) => row.session_id === 'session-unknown');

    expect(known?.project_path).toBe('/home/dev/proj-x');
    expect(unknown?.project_path).toBe(UNKNOWN_PROJECT_PATH);
  });

  it('computes started_at as the min at, last_event_at as the max at, and wall_ms as their difference', () => {
    const records: SessionEventRecord[] = [
      rec(promptEvent('session-a', 'proj-x'), BASE),
      rec(promptEvent('session-a', 'proj-x'), BASE + 5000),
    ];

    const rows = foldSessions(records, { now: BASE + 20_000, projectPaths: new Map() });
    const row = rows[0];

    expect(row?.started_at).toBe(new Date(BASE).toISOString());
    expect(row?.last_event_at).toBe(new Date(BASE + 5000).toISOString());
    expect(row?.wall_ms).toBe(5000);
  });

  it('marks a Session closed when idle for at least the idle window, open otherwise', () => {
    const idleMinutes = 30;
    const idleMs = idleMinutes * 60_000;

    const closedRecords: SessionEventRecord[] = [
      rec(promptEvent('session-closed', 'proj-x'), BASE),
    ];
    const openRecords: SessionEventRecord[] = [rec(promptEvent('session-open', 'proj-x'), BASE)];

    const closedRows = foldSessions(closedRecords, {
      now: BASE + idleMs,
      projectPaths: new Map(),
      idleMinutes,
    });
    const openRows = foldSessions(openRecords, {
      now: BASE + idleMs - 1,
      projectPaths: new Map(),
      idleMinutes,
    });

    expect(closedRows[0]?.closed).toBe(true);
    expect(openRows[0]?.closed).toBe(false);
  });

  it('defaults idleMinutes to SESSION_IDLE_MINUTES when not given', () => {
    const idleMs = SESSION_IDLE_MINUTES * 60_000;
    const records: SessionEventRecord[] = [rec(promptEvent('session-default', 'proj-x'), BASE)];

    const rows = foldSessions(records, { now: BASE + idleMs, projectPaths: new Map() });

    expect(rows[0]?.closed).toBe(true);
  });

  it('sets synthetic_session_id true when any record of the group has it true', () => {
    const records: SessionEventRecord[] = [
      rec(promptEvent('session-mixed', 'proj-x'), BASE, false),
      rec(promptEvent('session-mixed', 'proj-x'), BASE + 1000, true),
    ];

    const rows = foldSessions(records, { now: BASE + 10_000, projectPaths: new Map() });

    expect(rows[0]?.synthetic_session_id).toBe(true);
  });

  it('sorts rows by last_event_at descending, ties broken by session_id ascending', () => {
    const records: SessionEventRecord[] = [
      rec(promptEvent('session-early', 'proj-x'), BASE),
      rec(promptEvent('session-late', 'proj-x'), BASE + 5000),
      rec(promptEvent('session-tie-b', 'proj-x'), BASE + 2000),
      rec(promptEvent('session-tie-a', 'proj-x'), BASE + 2000),
    ];

    const rows = foldSessions(records, { now: BASE + 20_000, projectPaths: new Map() });

    expect(rows.map((row: SessionRow) => row.session_id)).toEqual([
      'session-late',
      'session-tie-a',
      'session-tie-b',
      'session-early',
    ]);
  });

  it('is pure: two calls on a frozen input give equal but distinct results, and leave the input unchanged', () => {
    const records: SessionEventRecord[] = [
      rec(promptEvent('session-a', 'proj-x'), BASE),
      rec(
        modelCallEvent('session-a', 'proj-x', { input_tokens: 1, output_tokens: 1 }),
        BASE + 1000,
      ),
    ];
    const frozen: readonly SessionEventRecord[] = Object.freeze([...records]);
    const beforeCopy: SessionEventRecord[] = structuredClone(records);

    const result1 = foldSessions(frozen, { now: BASE + 10_000, projectPaths: new Map() });
    const result2 = foldSessions(frozen, { now: BASE + 10_000, projectPaths: new Map() });

    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2);
    expect(frozen).toEqual(beforeCopy);
  });

  it('reopens a closed Session when a late Event arrives, and recomputes its summary', () => {
    const early: SessionEventRecord[] = [rec(promptEvent('session-reopen', 'proj-x'), BASE)];

    const earlyRows = foldSessions(early, {
      now: BASE + 40 * 60_000,
      projectPaths: new Map(),
    });
    const earlyRow = earlyRows[0];

    expect(earlyRow?.closed).toBe(true);
    expect(earlyRow?.prompts).toBe(1);
    expect(earlyRow?.wall_ms).toBe(0);

    const late: SessionEventRecord[] = [
      ...early,
      rec(
        modelCallEvent('session-reopen', 'proj-x', { input_tokens: 1, output_tokens: 1 }),
        BASE + 40 * 60_000,
      ),
    ];

    const lateRows = foldSessions(late, {
      now: BASE + 41 * 60_000,
      projectPaths: new Map(),
    });
    const lateRow = lateRows[0];

    expect(lateRow?.closed).toBe(false);
    expect(lateRow?.last_event_at).toBe(new Date(BASE + 40 * 60_000).toISOString());
    expect(lateRow?.started_at).toBe(new Date(BASE).toISOString());
    expect(lateRow?.wall_ms).toBe(40 * 60_000);
    expect(lateRow?.prompts).toBe(1);
    expect(lateRow?.model_calls).toBe(1);
  });

  it('lands run_id, task and variant as labels, and leaves them null for an ad hoc Session', () => {
    const runEvent: Event = {
      ...promptEvent('session-run', 'proj-x'),
      run_id: 'run-9',
      task: 'task-9',
      variant: 'variant-9',
    };
    const adhocEvent: Event = promptEvent('session-adhoc', 'proj-x');

    const records: SessionEventRecord[] = [rec(runEvent, BASE), rec(adhocEvent, BASE + 1000)];

    const rows = foldSessions(records, { now: BASE + 10_000, projectPaths: new Map() });
    const runRow = rows.find((row: SessionRow) => row.session_id === 'session-run');
    const adhocRow = rows.find((row: SessionRow) => row.session_id === 'session-adhoc');

    expect(runRow?.run_id).toBe('run-9');
    expect(runRow?.task).toBe('task-9');
    expect(runRow?.variant).toBe('variant-9');

    expect(adhocRow?.run_id).toBeNull();
    expect(adhocRow?.task).toBeNull();
    expect(adhocRow?.variant).toBeNull();
  });
});

describe('millisFromUnixNano', () => {
  it('converts a 19-digit nanosecond string to the correct millisecond number with no floating-point loss', () => {
    expect(millisFromUnixNano('1700000000123456789')).toBe(1_700_000_000_123);
  });

  it('returns undefined for a non-digit string', () => {
    expect(millisFromUnixNano('not-a-number')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(millisFromUnixNano('')).toBeUndefined();
  });

  it('returns undefined when the millisecond result exceeds Number.MAX_SAFE_INTEGER', () => {
    expect(millisFromUnixNano('9999999999999999999999')).toBeUndefined();
  });
});

describe('syntheticSessionId', () => {
  it('returns synthetic:<agent>:<project>:pid-<pid>', () => {
    expect(syntheticSessionId({ agent: 'claude-code', project: 'proj-x', pid: 1234 })).toBe(
      'synthetic:claude-code:proj-x:pid-1234',
    );
  });

  it('does not look like a Claude Code hyphenated UUID identifier', () => {
    const id = syntheticSessionId({ agent: 'claude-code', project: 'proj-x', pid: 1234 });

    expect(id).toMatch(/^synthetic:/);
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

describe('parseSince', () => {
  const nowMs = BASE;

  it('accepts an ISO 8601 instant', () => {
    expect(parseSince('2026-11-08T00:00:00.000Z', nowMs)).toBe(
      Date.parse('2026-11-08T00:00:00.000Z'),
    );
  });

  it('accepts a relative form in minutes, hours or days', () => {
    expect(parseSince('2h', nowMs)).toBe(nowMs - 7_200_000);
    expect(parseSince('30m', nowMs)).toBe(nowMs - 1_800_000);
    expect(parseSince('1d', nowMs)).toBe(nowMs - 86_400_000);
  });

  it('returns undefined for junk', () => {
    expect(parseSince('later', nowMs)).toBeUndefined();
    expect(parseSince('5x', nowMs)).toBeUndefined();
  });
});

describe('filterSessionRows', () => {
  const rows: SessionRow[] = [
    makeRow({
      session_id: 'session-a',
      agent: 'claude-code',
      project: 'proj-x',
      last_event_at: '2026-11-01T00:00:00.000Z',
    }),
    makeRow({
      session_id: 'session-b',
      agent: 'codex',
      project: 'proj-y',
      last_event_at: '2026-11-05T00:00:00.000Z',
    }),
  ];

  it('matches agent and project exactly', () => {
    expect(filterSessionRows(rows, { agent: 'claude-code' })).toEqual([rows[0]]);
    expect(filterSessionRows(rows, { project: 'proj-y' })).toEqual([rows[1]]);
  });

  it('keeps rows whose last_event_at is greater than or equal to sinceMs', () => {
    const sinceMs = Date.parse('2026-11-03T00:00:00.000Z');

    expect(filterSessionRows(rows, { sinceMs })).toEqual([rows[1]]);
  });

  it('returns every row for an empty filter object', () => {
    expect(filterSessionRows(rows, {})).toEqual(rows);
  });
});

describe('formatSessionsTable', () => {
  it('returns the single line "no sessions" for an empty array', () => {
    expect(formatSessionsTable([])).toBe('no sessions');
  });

  it('includes a header with every column name, and the session_id of each row', () => {
    const row = makeRow({ session_id: 'session-table', cost_usd: null });
    const output = formatSessionsTable([row]);
    const lines = output.split('\n');

    expect(lines[0]).toContain('session_id');
    expect(lines[0]).toContain('agent');
    expect(lines[0]).toContain('project');
    expect(lines[0]).toContain('started_at');
    expect(lines[0]).toContain('last_event_at');
    expect(lines[0]).toContain('closed');
    expect(lines[0]).toContain('model_calls');
    expect(lines[0]).toContain('tool_calls');
    expect(lines[0]).toContain('mcp_server_calls');
    expect(lines[0]).toContain('input_tokens');
    expect(lines[0]).toContain('output_tokens');
    expect(lines[0]).toContain('cost_usd');
    expect(lines.some((line: string) => line.includes('session-table'))).toBe(true);
  });

  it('prints a null cost_usd as -', () => {
    const row = makeRow({ session_id: 'session-null-cost', cost_usd: null });
    const output = formatSessionsTable([row]);

    expect(output.split('\n')[1]).toContain('-');
  });
});

describe('sessions store', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-sessions-'));
    tempDirs.push(dir);
    return join(dir, 'test.duckdb');
  }

  it('exposes default path constants', () => {
    expect(DEFAULT_RESULTS_PATH).toBe('results.duckdb');
    expect(DEFAULT_PROJECT_PATHS_FILE).toBe('data/project-paths.json');
  });

  it('upserts idempotently across two runs', async () => {
    const dbPath = await tempDbPath();
    const rows = [
      makeRow({ session_id: 'session-idem-1' }),
      makeRow({ session_id: 'session-idem-2' }),
    ];

    await upsertSessions(rows, dbPath);
    await upsertSessions(rows, dbPath);

    const read = await readSessions(dbPath);
    const sortBySessionId = (list: SessionRow[]): SessionRow[] =>
      [...list].sort((a, b) => a.session_id.localeCompare(b.session_id));

    expect(sortBySessionId(read)).toEqual(sortBySessionId(rows));
  });

  it('readSessions returns rows newest first, ties broken by session_id ascending', async () => {
    const dbPath = await tempDbPath();
    const rows = [
      makeRow({ session_id: 'session-mid', last_event_at: '2026-11-05T00:00:00.000Z' }),
      makeRow({ session_id: 'session-newest', last_event_at: '2026-11-07T00:00:00.000Z' }),
      makeRow({ session_id: 'session-tie-b', last_event_at: '2026-11-06T00:00:00.000Z' }),
      makeRow({ session_id: 'session-tie-a', last_event_at: '2026-11-06T00:00:00.000Z' }),
    ];

    await upsertSessions(rows, dbPath);

    const read = await readSessions(dbPath);

    expect(read.map((row: SessionRow) => row.session_id)).toEqual([
      'session-newest',
      'session-tie-a',
      'session-tie-b',
      'session-mid',
    ]);
  });

  it('recomputes a Session: upserting the same session_id with new totals replaces the row', async () => {
    const dbPath = await tempDbPath();
    const original = makeRow({ session_id: 'session-recompute', input_tokens: 10 });
    const updated = makeRow({ session_id: 'session-recompute', input_tokens: 99 });

    await upsertSessions([original], dbPath);
    await upsertSessions([updated], dbPath);

    const read = await readSessions(dbPath);

    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(updated);
  });

  it('round-trips: every row from readSessions parses against SessionRowSchema', async () => {
    const dbPath = await tempDbPath();
    const rows = [makeRow({ session_id: 'session-schema' })];

    await upsertSessions(rows, dbPath);
    const read = await readSessions(dbPath);

    for (const row of read) {
      expect(() => SessionRowSchema.parse(row)).not.toThrow();
    }
  });

  it('readProjectPaths resolves to an empty Map for a path that does not exist, never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-sessions-'));
    tempDirs.push(dir);
    const missingPath = join(dir, 'does-not-exist.json');

    const result = await readProjectPaths(missingPath);

    expect(result).toEqual(new Map());
  });
});

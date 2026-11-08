import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Adapter } from '../src/adapters/index.js';
import type { OtlpSender } from '../src/events/otlp.js';
import { foldRunAggregate } from '../src/events/fold.js';
import type { RunAggregate } from '../src/events/fold.js';
import { ResultsRowSchema } from '../src/schema/index.js';
import type { Event, ResultsRow, Task } from '../src/schema/index.js';

import {
  WARM_CACHE_BLOCKED,
  advanceTimeout,
  assertCacheSupported,
  buildResultsRow,
  initialTimeoutState,
  parseTaskYaml,
  parseVariantsYaml,
  planFixtureCopy,
  resolveVariant,
  runDirLayout,
} from '../src/runner/index.js';
import type { TimeoutLimits } from '../src/runner/index.js';

import { copyFixture, initWorkGit } from '../src/runner/fixture.js';
import { runChecker } from '../src/runner/checker.js';
import { upsertRuns, readRuns } from '../src/runner/store.js';
import { executeRun } from '../src/runner/lifecycle.js';
import type { LifecycleDeps, LifecycleFs, RunInput } from '../src/runner/lifecycle.js';

/**
 * Tests for the Runner's pure core (src/runner/index.ts), its three edge
 * modules (fixture.ts, checker.ts, store.ts), and its imperative shell
 * (lifecycle.ts). Every module above is absent today; importing it is the
 * expected RED failure.
 */

describe('aggregation', () => {
  it('matches the hand-computed totals over 9 Events, excluding the Event with a different run_id', () => {
    const events: Event[] = [
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        model: 'claude-opus-5',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 10,
        cost_usd: 0.5,
      },
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        model: 'claude-opus-5',
        input_tokens: 50,
        output_tokens: 5,
        cache_read_tokens: 0,
        cost_usd: 0.25,
      },
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        model: 'claude-opus-5',
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 1,
        cost_usd: 0.1,
      },
      {
        kind: 'tool_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        tool: 'probe_echo',
        success: true,
        tool_type: 'mcp',
        mcp_server: 'probe',
      },
      {
        kind: 'tool_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        tool: 'other_tool',
        success: true,
        tool_type: 'native',
      },
      {
        kind: 'mcp_server_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        'mcp_server.call_id': 'call-agg-1',
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': 'probe_echo',
        'mcp_server.total_ms': 5,
        'mcp_server.status': 'ok',
        'mcp_server.cache': 'hit',
      },
      {
        kind: 'mcp_server_call',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        'mcp_server.call_id': 'call-agg-2',
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': 'probe_echo',
        'mcp_server.total_ms': 7,
        'mcp_server.status': 'ok',
        'mcp_server.cache': 'hit',
      },
      {
        kind: 'prompt',
        agent: 'claude-code',
        session_id: 'session-agg',
        project: 'proj-agg',
        run_id: 'run-agg-1',
        prompt_length: 33,
      },
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-other',
        project: 'proj-agg',
        run_id: 'run-agg-2',
        model: 'claude-opus-5',
        input_tokens: 999,
        output_tokens: 999,
        cache_read_tokens: 999,
        cost_usd: 999,
      },
    ];

    expect(events).toHaveLength(9);

    const aggregate = foldRunAggregate(events, {
      runId: 'run-agg-1',
      expectedTools: ['probe_echo'],
    });

    expect(aggregate).toEqual({
      turns: 3,
      tool_calls: 2,
      mcp_server_calls: 2,
      // input_tokens: 100 + 50 + 10 = 160
      input_tokens: 160,
      // output_tokens: 20 + 5 + 2 = 27
      output_tokens: 27,
      // cache_read_tokens: 10 + 0 + 1 = 11
      cache_read_tokens: 11,
      cache_hits: 2,
      expected_tools_hit: true,
      // cost_usd: 0.5 + 0.25 + 0.1 = 0.85
      cost_usd: 0.85,
    });

    expect(aggregate.input_tokens).not.toBe(160 + 999);
    expect(aggregate.output_tokens).not.toBe(27 + 999);
    expect(aggregate.cache_read_tokens).not.toBe(11 + 999);
    expect(aggregate.cost_usd).not.toBe(0.85 + 999);
  });
});

describe('Results row', () => {
  const aggregate: RunAggregate = {
    turns: 4,
    tool_calls: 1,
    mcp_server_calls: 1,
    input_tokens: 40,
    output_tokens: 10,
    cache_read_tokens: 5,
    cache_hits: 1,
    expected_tools_hit: true,
    cost_usd: 0.2,
  };

  it('builds a row ResultsRowSchema accepts, with pass true for checker_exit_code 0', () => {
    const row = buildResultsRow({
      run_id: 'run-results-1',
      started_at: '2026-11-08T00:00:00.000Z',
      task: 'hello',
      agent: 'claude-code',
      variant: 'none',
      cache: 'cold',
      rep: 0,
      wall_ms: 1500,
      exit_code: 0,
      timed_out: false,
      checker_exit_code: 0,
      checker_output: 'ok\n',
      aggregate,
    });

    expect(() => ResultsRowSchema.parse(row)).not.toThrow();
    expect(row.pass).toBe(true);
    expect(row.input_tokens_per_turn).toBe(10);
  });

  it('gives pass false for checker_exit_code 1', () => {
    const row = buildResultsRow({
      run_id: 'run-results-2',
      started_at: '2026-11-08T00:00:00.000Z',
      task: 'hello',
      agent: 'claude-code',
      variant: 'none',
      cache: 'cold',
      rep: 0,
      wall_ms: 1500,
      exit_code: 0,
      timed_out: false,
      checker_exit_code: 1,
      checker_output: 'fail\n',
      aggregate,
    });

    expect(row.pass).toBe(false);
  });

  it('gives input_tokens_per_turn 0 when aggregate.turns is 0', () => {
    const row = buildResultsRow({
      run_id: 'run-results-3',
      started_at: '2026-11-08T00:00:00.000Z',
      task: 'hello',
      agent: 'claude-code',
      variant: 'none',
      cache: 'cold',
      rep: 0,
      wall_ms: 1500,
      exit_code: 0,
      timed_out: false,
      checker_exit_code: 0,
      checker_output: 'ok\n',
      aggregate: { ...aggregate, turns: 0 },
    });

    expect(row.input_tokens_per_turn).toBe(0);
  });
});

describe('timeout machine', () => {
  const limits: TimeoutLimits = { timeout_ms: 1000, grace_ms: 500 };

  it('returns phase running, timed_out false, term_at_ms null initially', () => {
    expect(initialTimeoutState()).toEqual({ phase: 'running', timed_out: false, term_at_ms: null });
  });

  it('stays running on a tick below timeout_ms, action none', () => {
    const result = advanceTimeout(initialTimeoutState(), { type: 'tick', elapsed_ms: 999 }, limits);

    expect(result.state).toEqual({ phase: 'running', timed_out: false, term_at_ms: null });
    expect(result.action).toBe('none');
  });

  it('moves to term_sent on a tick at timeout_ms, with term_at_ms set, action send_sigterm', () => {
    const result = advanceTimeout(
      initialTimeoutState(),
      { type: 'tick', elapsed_ms: 1000 },
      limits,
    );

    expect(result.state.phase).toBe('term_sent');
    expect(result.state.term_at_ms).toBe(1000);
    expect(result.action).toBe('send_sigterm');
  });

  it('moves running to exited on exit, timed_out false, action none', () => {
    const result = advanceTimeout(initialTimeoutState(), { type: 'exit' }, limits);

    expect(result.state.phase).toBe('exited');
    expect(result.state.timed_out).toBe(false);
    expect(result.action).toBe('none');
  });

  it('stays term_sent on a tick below term_at_ms + grace_ms, action none', () => {
    const termSent = advanceTimeout(
      initialTimeoutState(),
      { type: 'tick', elapsed_ms: 1000 },
      limits,
    );

    const result = advanceTimeout(termSent.state, { type: 'tick', elapsed_ms: 1499 }, limits);

    expect(result.state.phase).toBe('term_sent');
    expect(result.state.term_at_ms).toBe(1000);
    expect(result.action).toBe('none');
  });

  it('moves term_sent to kill_sent on a tick at term_at_ms + grace_ms, action send_sigkill', () => {
    const termSent = advanceTimeout(
      initialTimeoutState(),
      { type: 'tick', elapsed_ms: 1000 },
      limits,
    );

    const result = advanceTimeout(termSent.state, { type: 'tick', elapsed_ms: 1500 }, limits);

    expect(result.state.phase).toBe('kill_sent');
    expect(result.action).toBe('send_sigkill');
  });

  it('moves term_sent to exited on exit, timed_out true', () => {
    const termSent = advanceTimeout(
      initialTimeoutState(),
      { type: 'tick', elapsed_ms: 1000 },
      limits,
    );

    const result = advanceTimeout(termSent.state, { type: 'exit' }, limits);

    expect(result.state.phase).toBe('exited');
    expect(result.state.timed_out).toBe(true);
  });

  it('moves kill_sent to exited on exit, timed_out true', () => {
    const termSent = advanceTimeout(
      initialTimeoutState(),
      { type: 'tick', elapsed_ms: 1000 },
      limits,
    );
    const killSent = advanceTimeout(termSent.state, { type: 'tick', elapsed_ms: 1500 }, limits);

    const result = advanceTimeout(killSent.state, { type: 'exit' }, limits);

    expect(result.state.phase).toBe('exited');
    expect(result.state.timed_out).toBe(true);
  });

  it('stays exited on any further input, action none', () => {
    const exited = advanceTimeout(initialTimeoutState(), { type: 'exit' }, limits);

    const afterTick = advanceTimeout(exited.state, { type: 'tick', elapsed_ms: 99999 }, limits);
    const afterExit = advanceTimeout(exited.state, { type: 'exit' }, limits);

    expect(afterTick.state.phase).toBe('exited');
    expect(afterTick.action).toBe('none');
    expect(afterExit.state.phase).toBe('exited');
    expect(afterExit.action).toBe('none');
  });

  it('planFixtureCopy drops .git and .git/config, keeping src/a.ts in place', () => {
    const result = planFixtureCopy(['.git', '.git/config', 'src/a.ts']);

    expect(result).toEqual(['src/a.ts']);
  });

  it('runDirLayout puts all five paths under <runsRoot>/<runId>', () => {
    const runsRoot = '/tmp/agent-telemetry-runs';
    const runId = 'run-layout-1';
    const base = join(runsRoot, runId);

    const layout = runDirLayout(runsRoot, runId);

    expect(layout).toEqual({
      root: base,
      work: join(base, 'work'),
      mcpConfig: join(base, 'mcp.json'),
      agentLog: join(base, 'agent.log'),
      checkerLog: join(base, 'checker.log'),
    });
  });
});

describe('fixture copy', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('copies every file except .git, leaves the source untouched, and initWorkGit creates .git in the destination', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-telemetry-runner-fixture-'));
    tempDirs.push(root);

    const from = join(root, 'from');
    const to = join(root, 'to');

    mkdirSync(join(from, 'nested'), { recursive: true });
    mkdirSync(join(from, '.git'), { recursive: true });
    writeFileSync(join(from, 'a.txt'), 'a');
    writeFileSync(join(from, 'nested', 'b.txt'), 'b');
    writeFileSync(join(from, '.git', 'config'), 'config');

    const copied = await copyFixture(from, to);

    expect(existsSync(join(to, 'nested', 'b.txt'))).toBe(true);
    expect(existsSync(join(to, '.git'))).toBe(false);
    expect(copied).not.toContain('.git/config');
    expect(existsSync(join(from, 'a.txt'))).toBe(true);
    expect(existsSync(join(from, 'nested', 'b.txt'))).toBe(true);
    expect(existsSync(join(from, '.git', 'config'))).toBe(true);

    await initWorkGit(to);

    expect(existsSync(join(to, '.git'))).toBe(true);
  });
});

function createFakeAdapter(recorders: {
  launchEnvs: Record<string, string>[];
  sleep: (ms: number) => Promise<void>;
}): Adapter {
  return {
    name: 'claude-code',
    telemetryEnv: (p) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: p.endpoint }),
    transcriptPaths: () => Promise.resolve([]),
    launch: (p) => {
      recorders.launchEnvs.push(p.env);

      // A test fake is the one place a cast is legitimate: the fake child is
      // not a real ChildProcess, only a value `launch` must hand back
      // unchanged (test/adapter.test.ts:69-78 uses the same note).
      const fakeChild = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: (): boolean => true,
        pid: 1234,
      }) as unknown as ChildProcess;

      void recorders.sleep(0).then(() => {
        fakeChild.emit('exit', 0, null);
      });

      return fakeChild;
    },
  };
}

function createFakeFs(recordedPaths: string[]): LifecycleFs {
  return {
    mkdir: (path) => {
      recordedPaths.push(path);
      return Promise.resolve();
    },
    copyFixture: (_from, to) => {
      recordedPaths.push(to);
      return Promise.resolve([]);
    },
    initWorkGit: async () => {},
    openLog: (path) => {
      recordedPaths.push(path);
      return Promise.resolve({
        write: () => {},
        close: () => Promise.resolve(),
      });
    },
    byteLength: () => Promise.resolve(0),
  };
}

function createFakeTask(): Task {
  return {
    id: 'hello',
    prompt: 'say hello',
    fixture: 'fixtures/empty',
    checker: 'test -f hello.txt',
    expected_tools: [],
    timeout_s: 300,
    tags: [],
  };
}

describe('per-Run files', () => {
  it('writes only under the temporary runs root, mints one row, and emits run_start then run_end', async () => {
    const runsRoot = '/tmp/agent-telemetry-test-runs';
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const recordedPaths: string[] = [];
    const launchEnvs: Record<string, string>[] = [];
    const upsertCalls: { rows: ResultsRow[]; path: string }[] = [];
    const senderEvents: string[] = [];

    let clockMs = 0;
    const fakeSleep = (ms: number): Promise<void> => {
      clockMs += ms;
      return Promise.resolve();
    };

    const fakeSender: OtlpSender = {
      enabled: true,
      emit: (_event, eventName) => {
        senderEvents.push(eventName);
      },
      flush: async () => {},
      shutdown: async () => {},
    };

    const deps: LifecycleDeps = {
      runsRoot,
      eventsPath: join(runsRoot, 'events.jsonl'),
      resultsPath: join(runsRoot, 'results.duckdb'),
      endpoint: 'http://localhost:4318',
      project: 'proj-x',
      projectPath: '/fake/repo',
      baseEnv: { PATH: '/usr/bin' },
      adapter: createFakeAdapter({ launchEnvs, sleep: fakeSleep }),
      fs: createFakeFs(recordedPaths),
      ulid: () => runId,
      nowMs: () => clockMs,
      nowIso: () => '2026-11-08T00:00:00.000Z',
      runChecker: () => Promise.resolve({ exit_code: 0, output: '', timed_out: false }),
      createSender: () => fakeSender,
      readWindow: () =>
        Promise.resolve({
          events: [],
          records: [],
          unknownKindsByAgent: {},
          malformed: 0,
          lines: 0,
        }),
      upsertRuns: (rows, path) => {
        upsertCalls.push({ rows: [...rows], path });
        return Promise.resolve(rows.length);
      },
      sleep: fakeSleep,
    };

    const input: RunInput = {
      task: createFakeTask(),
      variantName: 'none',
      variant: { servers: [] },
      cache: 'cold',
      rep: 0,
    };

    const row = await executeRun(input, deps);

    expect(recordedPaths.length).toBeGreaterThan(0);
    for (const path of recordedPaths) {
      expect(path.startsWith(runsRoot)).toBe(true);
    }
    expect(recordedPaths.some((path) => path.startsWith(homedir()))).toBe(false);

    const layout = runDirLayout(runsRoot, runId);
    expect(recordedPaths).toContain(layout.agentLog);

    expect(upsertCalls).toHaveLength(1);
    const [upsertCall] = upsertCalls;
    expect(upsertCall).toBeDefined();
    if (upsertCall !== undefined) {
      expect(upsertCall.rows).toHaveLength(1);
      const [resultRow] = upsertCall.rows;
      expect(resultRow).toBeDefined();
      if (resultRow !== undefined) {
        expect(resultRow.run_id).toBe(runId);
      }
    }

    expect(senderEvents.filter((name) => name === 'runner.run_start')).toHaveLength(1);
    expect(senderEvents.filter((name) => name === 'runner.run_end')).toHaveLength(1);

    for (const env of launchEnvs) {
      expect(Object.keys(env)).not.toContain('OTEL_LOG_USER_PROMPTS');
    }

    expect(row.run_id).toBe(runId);
  });
});

describe('resource attributes', () => {
  it('hands adapter.telemetryEnv a resource carrying project_path from deps.projectPath', async () => {
    const runsRoot = '/tmp/agent-telemetry-test-runs-project-path';
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const projectPath = '/fake/repo';

    const recordedResources: Record<string, string>[] = [];

    let clockMs = 0;
    const fakeSleep = (ms: number): Promise<void> => {
      clockMs += ms;
      return Promise.resolve();
    };

    const fakeAdapter: Adapter = {
      name: 'fake-adapter',
      telemetryEnv: (p) => {
        recordedResources.push(p.resource);
        return {};
      },
      transcriptPaths: () => Promise.resolve([]),
      launch: () => {
        // A test fake is the one place a cast is legitimate: see the note
        // on `createFakeAdapter` above.
        const fakeChild = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: (): boolean => true,
          pid: 1234,
        }) as unknown as ChildProcess;

        void fakeSleep(0).then(() => {
          fakeChild.emit('exit', 0, null);
        });

        return fakeChild;
      },
    };

    const fakeSender: OtlpSender = {
      enabled: true,
      emit: () => {},
      flush: async () => {},
      shutdown: async () => {},
    };

    const deps: LifecycleDeps = {
      runsRoot,
      eventsPath: join(runsRoot, 'events.jsonl'),
      resultsPath: join(runsRoot, 'results.duckdb'),
      endpoint: 'http://localhost:4318',
      project: 'proj-x',
      projectPath,
      baseEnv: { PATH: '/usr/bin' },
      adapter: fakeAdapter,
      fs: createFakeFs([]),
      ulid: () => runId,
      nowMs: () => clockMs,
      nowIso: () => '2026-11-08T00:00:00.000Z',
      runChecker: () => Promise.resolve({ exit_code: 0, output: '', timed_out: false }),
      createSender: () => fakeSender,
      readWindow: () =>
        Promise.resolve({
          events: [],
          records: [],
          unknownKindsByAgent: {},
          malformed: 0,
          lines: 0,
        }),
      upsertRuns: (rows) => Promise.resolve(rows.length),
      sleep: fakeSleep,
    };

    const input: RunInput = {
      task: createFakeTask(),
      variantName: 'none',
      variant: { servers: [] },
      cache: 'cold',
      rep: 0,
    };

    await executeRun(input, deps);

    expect(recordedResources).toHaveLength(1);
    expect(recordedResources[0]).toEqual({
      run_id: runId,
      task: 'hello',
      variant: 'none',
      config: 'cold',
      agent: 'fake-adapter',
      project_path: projectPath,
    });
  });
});

describe('cache state', () => {
  it('does not throw for cache "cold"', () => {
    expect(() => {
      assertCacheSupported('cold');
    }).not.toThrow();
  });

  it('throws WARM_CACHE_BLOCKED for cache "warm"', () => {
    expect(() => {
      assertCacheSupported('warm');
    }).toThrow(WARM_CACHE_BLOCKED);
  });

  it('rejects executeRun with WARM_CACHE_BLOCKED and records no fs path when cache is warm', async () => {
    const runsRoot = '/tmp/agent-telemetry-test-runs-warm';
    const recordedPaths: string[] = [];
    const launchEnvs: Record<string, string>[] = [];

    let clockMs = 0;
    const fakeSleep = (ms: number): Promise<void> => {
      clockMs += ms;
      return Promise.resolve();
    };

    const fakeSender: OtlpSender = {
      enabled: true,
      emit: () => {},
      flush: async () => {},
      shutdown: async () => {},
    };

    const deps: LifecycleDeps = {
      runsRoot,
      eventsPath: join(runsRoot, 'events.jsonl'),
      resultsPath: join(runsRoot, 'results.duckdb'),
      endpoint: 'http://localhost:4318',
      project: 'proj-x',
      projectPath: '/fake/repo',
      baseEnv: { PATH: '/usr/bin' },
      adapter: createFakeAdapter({ launchEnvs, sleep: fakeSleep }),
      fs: createFakeFs(recordedPaths),
      ulid: () => '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      nowMs: () => clockMs,
      nowIso: () => '2026-11-08T00:00:00.000Z',
      runChecker: () => Promise.resolve({ exit_code: 0, output: '', timed_out: false }),
      createSender: () => fakeSender,
      readWindow: () =>
        Promise.resolve({
          events: [],
          records: [],
          unknownKindsByAgent: {},
          malformed: 0,
          lines: 0,
        }),
      upsertRuns: (rows) => Promise.resolve(rows.length),
      sleep: fakeSleep,
    };

    const input: RunInput = {
      task: createFakeTask(),
      variantName: 'none',
      variant: { servers: [] },
      cache: 'warm',
      rep: 0,
    };

    await expect(executeRun(input, deps)).rejects.toThrow(WARM_CACHE_BLOCKED);
    expect(recordedPaths).toEqual([]);
  });
});

describe('Variant and Task load', () => {
  it('parses configs/variants.yaml into none (0 servers) and probe (1 server named probe)', () => {
    const text = readFileSync('configs/variants.yaml', 'utf8');
    const file = parseVariantsYaml(text);

    expect(file.variants['none']?.servers).toHaveLength(0);
    expect(file.variants['probe']?.servers).toHaveLength(1);
    expect(file.variants['probe']?.servers[0]?.name).toBe('probe');
  });

  it('resolveVariant throws, naming the unknown variant, for a name not in the file', () => {
    const text = readFileSync('configs/variants.yaml', 'utf8');
    const file = parseVariantsYaml(text);

    expect(() => resolveVariant(file, 'bogus-variant')).toThrow(/bogus-variant/);
  });

  it('parses tasks/hello.yaml into id hello, timeout_s 300, expected_tools []', () => {
    const text = readFileSync('tasks/hello.yaml', 'utf8');
    const task = parseTaskYaml(text);

    expect(task.id).toBe('hello');
    expect(task.timeout_s).toBe(300);
    expect(task.expected_tools).toEqual([]);
  });
});

describe('Checker', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('resolves exit_code 0 when hello.txt exists in cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-checker-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'hello.txt'), 'hello');

    const result = await runChecker({ command: 'test -f hello.txt', cwd: dir });

    expect(result.exit_code).toBe(0);
  });

  it('resolves a non-zero exit_code when hello.txt is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-checker-'));
    tempDirs.push(dir);

    const result = await runChecker({ command: 'test -f hello.txt', cwd: dir });

    expect(result.exit_code).not.toBe(0);
  });

  it('puts standard-error text in output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-checker-'));
    tempDirs.push(dir);

    const result = await runChecker({ command: 'echo checker-stderr-text 1>&2', cwd: dir });

    expect(result.output).toContain('checker-stderr-text');
  });
});

describe('store', () => {
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
    const dir = await mkdtemp(join(tmpdir(), 'agent-telemetry-runner-store-'));
    tempDirs.push(dir);
    return join(dir, 'test.duckdb');
  }

  function makeRow(overrides: Partial<ResultsRow> = {}): ResultsRow {
    return {
      run_id: 'run-store-1',
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

  it('round-trips all 22 fields of one row through upsertRuns and readRuns', async () => {
    const dbPath = await tempDbPath();
    const row = makeRow();
    expect(Object.keys(row)).toHaveLength(22);

    await upsertRuns([row], dbPath);
    const read = await readRuns(dbPath);

    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(row);
  });

  it('upserting the same run_id with a changed input_tokens leaves one row carrying the new value', async () => {
    const dbPath = await tempDbPath();
    const original = makeRow({ run_id: 'run-store-2', input_tokens: 10 });
    const updated = makeRow({ run_id: 'run-store-2', input_tokens: 99 });

    await upsertRuns([original], dbPath);
    await upsertRuns([updated], dbPath);

    const read = await readRuns(dbPath);

    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(updated);
  });
});

import { describe, expect, it } from 'vitest';
import { filterByRunId, foldRunAggregate, foldSessionTotals } from '../src/events/fold.js';
import type { Event } from '../src/schema/index.js';

const events: Event[] = [
  {
    kind: 'prompt',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    run_id: 'run-1',
    prompt_length: 42,
  },
  {
    kind: 'model_call',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    run_id: 'run-1',
    model: 'claude-opus-5',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 10,
    cache_write_tokens: 5,
    reasoning_tokens: 7,
    cost_usd: 0.25,
  },
  {
    kind: 'tool_call',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    run_id: 'run-1',
    tool: 'probe_echo',
    success: true,
    tool_type: 'mcp',
    mcp_server: 'probe',
  },
  {
    kind: 'mcp_server_call',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    run_id: 'run-1',
    'mcp_server.call_id': 'call-1',
    'mcp.method.name': 'tools/call',
    'gen_ai.tool.name': 'probe_echo',
    'mcp_server.total_ms': 12,
    'mcp_server.status': 'ok',
    'mcp_server.cache': 'hit',
  },
  {
    kind: 'model_call',
    agent: 'claude-code',
    session_id: 'session-b',
    project: 'proj-x',
    run_id: 'run-1',
    model: 'claude-opus-5',
    input_tokens: 30,
    output_tokens: 4,
  },
  {
    kind: 'model_call',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    model: 'claude-opus-5',
    input_tokens: 1,
    output_tokens: 2,
  },
  {
    kind: 'api_error',
    agent: 'claude-code',
    session_id: 'session-a',
    project: 'proj-x',
    run_id: 'run-1',
    error_type: 'overloaded_error',
    status_code: 529,
    attempt: 2,
  },
];

describe('foldSessionTotals', () => {
  it('returns [] for an empty Event array', () => {
    expect(foldSessionTotals([])).toEqual([]);
  });

  it('returns one row per session_id, in first-appearance order, with the hand-computed totals', () => {
    expect(foldSessionTotals(events)).toEqual([
      {
        session_id: 'session-a',
        agent: 'claude-code',
        project: 'proj-x',
        run_id: 'run-1',
        task: null,
        variant: null,
        model_calls: 2,
        tool_calls: 1,
        mcp_server_calls: 1,
        prompts: 1,
        api_errors: 1,
        input_tokens: 101,
        output_tokens: 22,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        reasoning_tokens: 7,
        cost_usd: 0.25,
      },
      {
        session_id: 'session-b',
        agent: 'claude-code',
        project: 'proj-x',
        run_id: 'run-1',
        task: null,
        variant: null,
        model_calls: 1,
        tool_calls: 0,
        mcp_server_calls: 0,
        prompts: 0,
        api_errors: 0,
        input_tokens: 30,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: null,
      },
    ]);
  });

  it('takes the first non-absent run_id for a Session, even when an earlier Event lacks it', () => {
    const noRunIdFirst: Event[] = [
      {
        kind: 'prompt',
        agent: 'claude-code',
        session_id: 'session-e',
        project: 'proj-x',
        prompt_length: 10,
      },
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-e',
        project: 'proj-x',
        run_id: 'run-2',
        model: 'claude-opus-5',
        input_tokens: 1,
        output_tokens: 1,
      },
    ];

    expect(foldSessionTotals(noRunIdFirst)).toEqual([
      {
        session_id: 'session-e',
        agent: 'claude-code',
        project: 'proj-x',
        run_id: 'run-2',
        task: null,
        variant: null,
        model_calls: 1,
        tool_calls: 0,
        mcp_server_calls: 0,
        prompts: 1,
        api_errors: 0,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        cost_usd: null,
      },
    ]);
  });

  it('does not let a run_end Event contribute to the token sums of its Session', () => {
    const runEndEvents: Event[] = [
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-d',
        project: 'proj-x',
        run_id: 'run-3',
        model: 'claude-opus-5',
        input_tokens: 5,
        output_tokens: 6,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
        reasoning_tokens: 1,
        cost_usd: 0.1,
      },
      {
        kind: 'run_end',
        agent: 'claude-code',
        session_id: 'session-d',
        project: 'proj-x',
        run_id: 'run-3',
        rep: 0,
        wall_ms: 1000,
        turns: 999,
        tool_calls: 999,
        mcp_server_calls: 999,
        input_tokens: 9999,
        output_tokens: 9999,
        cache_read_tokens: 9999,
        pass: true,
        timed_out: false,
        expected_tools_hit: true,
      },
    ];

    expect(foldSessionTotals(runEndEvents)).toEqual([
      {
        session_id: 'session-d',
        agent: 'claude-code',
        project: 'proj-x',
        run_id: 'run-3',
        task: null,
        variant: null,
        model_calls: 1,
        tool_calls: 0,
        mcp_server_calls: 0,
        prompts: 0,
        api_errors: 0,
        input_tokens: 5,
        output_tokens: 6,
        cache_read_tokens: 1,
        cache_write_tokens: 1,
        reasoning_tokens: 1,
        cost_usd: 0.1,
      },
    ]);
  });

  it('is pure: two calls on a frozen input give equal but distinct results, and leave the input unchanged', () => {
    const frozen: readonly Event[] = Object.freeze([...events]);
    const beforeCopy: Event[] = structuredClone(events);

    const result1 = foldSessionTotals(frozen);
    const result2 = foldSessionTotals(frozen);

    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2);
    expect(frozen).toEqual(beforeCopy);
  });
});

describe('foldRunAggregate', () => {
  it('returns every number at 0 and expected_tools_hit false for an empty Event array', () => {
    expect(foldRunAggregate([], { runId: 'run-1', expectedTools: [] })).toEqual({
      turns: 0,
      tool_calls: 0,
      mcp_server_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_hits: 0,
      expected_tools_hit: false,
      cost_usd: null,
    });
  });

  it('filters by run_id, excludes the model_call with no run_id, and matches the hand-computed totals', () => {
    expect(foldRunAggregate(events, { runId: 'run-1', expectedTools: ['probe_echo'] })).toEqual({
      turns: 2,
      tool_calls: 1,
      mcp_server_calls: 1,
      input_tokens: 130,
      output_tokens: 24,
      cache_read_tokens: 10,
      cache_hits: 1,
      expected_tools_hit: true,
      // cost_usd: 0.25 from the first model_call; the second carries none
      cost_usd: 0.25,
    });
  });

  it('gives expected_tools_hit false when expectedTools is empty', () => {
    expect(foldRunAggregate(events, { runId: 'run-1', expectedTools: [] }).expected_tools_hit).toBe(
      false,
    );
  });

  it('gives expected_tools_hit false when the FIRST tool_call is outside expectedTools, even when a later one is inside', () => {
    const twoToolCalls: Event[] = [
      {
        kind: 'tool_call',
        agent: 'claude-code',
        session_id: 'session-c',
        project: 'proj-x',
        run_id: 'run-9',
        tool: 'other_tool',
        success: true,
        tool_type: 'native',
      },
      {
        kind: 'tool_call',
        agent: 'claude-code',
        session_id: 'session-c',
        project: 'proj-x',
        run_id: 'run-9',
        tool: 'probe_echo',
        success: true,
        tool_type: 'mcp',
        mcp_server: 'probe',
      },
    ];

    expect(
      foldRunAggregate(twoToolCalls, { runId: 'run-9', expectedTools: ['probe_echo'] })
        .expected_tools_hit,
    ).toBe(false);
  });

  it('ignores mcp_server_call Events whose cache is miss, bypass, or stale', () => {
    const cacheEvents: Event[] = [
      {
        kind: 'mcp_server_call',
        agent: 'claude-code',
        session_id: 'session-f',
        project: 'proj-x',
        run_id: 'run-5',
        'mcp_server.call_id': 'call-miss',
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': 'probe_echo',
        'mcp_server.total_ms': 1,
        'mcp_server.status': 'ok',
        'mcp_server.cache': 'miss',
      },
      {
        kind: 'mcp_server_call',
        agent: 'claude-code',
        session_id: 'session-f',
        project: 'proj-x',
        run_id: 'run-5',
        'mcp_server.call_id': 'call-bypass',
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': 'probe_echo',
        'mcp_server.total_ms': 1,
        'mcp_server.status': 'ok',
        'mcp_server.cache': 'bypass',
      },
      {
        kind: 'mcp_server_call',
        agent: 'claude-code',
        session_id: 'session-f',
        project: 'proj-x',
        run_id: 'run-5',
        'mcp_server.call_id': 'call-stale',
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': 'probe_echo',
        'mcp_server.total_ms': 1,
        'mcp_server.status': 'ok',
        'mcp_server.cache': 'stale',
      },
    ];

    expect(foldRunAggregate(cacheEvents, { runId: 'run-5', expectedTools: [] }).cache_hits).toBe(0);
  });

  it('sums cost_usd across the model_call Events of the Run', () => {
    const costEvents: Event[] = [
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-cost',
        project: 'proj-x',
        run_id: 'run-cost-1',
        model: 'claude-opus-5',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0.3,
      },
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-cost',
        project: 'proj-x',
        run_id: 'run-cost-1',
        model: 'claude-opus-5',
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0.2,
      },
    ];

    // cost_usd: 0.3 + 0.2 = 0.5
    expect(foldRunAggregate(costEvents, { runId: 'run-cost-1', expectedTools: [] }).cost_usd).toBe(
      0.5,
    );
  });

  it('gives cost_usd null when no model_call Event of the Run carries cost_usd', () => {
    const noCostEvents: Event[] = [
      {
        kind: 'model_call',
        agent: 'claude-code',
        session_id: 'session-nocost',
        project: 'proj-x',
        run_id: 'run-nocost-1',
        model: 'claude-opus-5',
        input_tokens: 1,
        output_tokens: 1,
      },
    ];

    expect(
      foldRunAggregate(noCostEvents, { runId: 'run-nocost-1', expectedTools: [] }).cost_usd,
    ).toBeNull();
  });

  it('is pure: two calls on a frozen input give equal but distinct results, and leave the input unchanged', () => {
    const frozen: readonly Event[] = Object.freeze([...events]);
    const beforeCopy: Event[] = structuredClone(events);

    const result1 = foldRunAggregate(frozen, { runId: 'run-1', expectedTools: ['probe_echo'] });
    const result2 = foldRunAggregate(frozen, { runId: 'run-1', expectedTools: ['probe_echo'] });

    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2);
    expect(frozen).toEqual(beforeCopy);
  });
});

describe('filterByRunId', () => {
  it('returns the 6 Events matching run-1 out of the 7-Event array, as a new array', () => {
    const result = filterByRunId(events, 'run-1');

    expect(result).toHaveLength(6);
    expect(result).not.toBe(events);
  });
});

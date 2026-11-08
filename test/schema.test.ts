import { describe, expect, it } from 'vitest';
import {
  ApiErrorEventSchema,
  EventSchema,
  KindSchema,
  McpServerCallEventSchema,
  ModelCallEventSchema,
  PromptEventSchema,
  ResourceAttributesSchema,
  ResultsRowSchema,
  RunEndEventSchema,
  RunStartEventSchema,
  SessionRowSchema,
  TaskSchema,
  ToolCallEventSchema,
  VariantsFileSchema,
} from '../src/schema/index.js';

function resourceBase() {
  return {
    agent: 'claude-code',
    session_id: 'session-1',
    project: 'agent-telemetry-abcd1234',
  };
}

function mcpServerCallBase() {
  return {
    ...resourceBase(),
    kind: 'mcp_server_call',
    'mcp_server.call_id': '01HZCALL00000000000000001',
    'mcp.method.name': 'tools/call',
    'gen_ai.tool.name': 'probe',
    'mcp_server.total_ms': 120,
    'mcp_server.status': 'ok',
  };
}

function taskBase() {
  return {
    id: 'hello',
    prompt: 'Create hello.txt containing the word hello.',
    fixture: 'fixtures/hello',
    checker: 'test -f hello.txt',
  };
}

function variantsFileBase() {
  return {
    variants: {
      none: { servers: [] },
      probe: {
        servers: [{ name: 'probe', command: 'node', args: ['probe-server.js'], env: {} }],
      },
    },
  };
}

function sessionRowBase() {
  return {
    session_id: 'session-1',
    agent: 'claude-code',
    project: 'agent-telemetry-abcd1234',
    project_path: '/home/user/project',
    started_at: '2026-11-08T00:00:00.000Z',
    last_event_at: '2026-11-08T00:05:00.000Z',
    closed: false,
    synthetic_session_id: false,
    model_calls: 3,
    tool_calls: 2,
    mcp_server_calls: 0,
    prompts: 1,
    api_errors: 0,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    cost_usd: null,
    wall_ms: 5000,
    run_id: null,
    task: null,
    variant: null,
  };
}

function resultsRowBase() {
  return {
    run_id: '01HZRUN000000000000000001',
    started_at: '2026-11-08T00:00:00.000Z',
    task: 'hello',
    agent: 'claude-code',
    variant: 'none',
    cache: 'cold',
    rep: 0,
    pass: true,
    exit_code: 0,
    timed_out: false,
    wall_ms: 5000,
    turns: 3,
    tool_calls: 2,
    mcp_server_calls: 0,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    input_tokens_per_turn: 33.3,
    cost_usd: 0.01,
    expected_tools_hit: true,
    cache_hits: 0,
    checker_output: 'ok',
  };
}

describe('model_call', () => {
  it('parses a valid model_call event', () => {
    const result = ModelCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'model_call',
      model: 'claude-sonnet-5',
    });
    expect(result.success).toBe(true);
  });

  it('model_call rejects a negative input_tokens value', () => {
    const result = ModelCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'model_call',
      model: 'claude-sonnet-5',
      input_tokens: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('tool_call', () => {
  it('parses a valid tool_call event', () => {
    const result = ToolCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'tool_call',
      tool: 'Read',
      success: true,
      tool_type: 'native',
    });
    expect(result.success).toBe(true);
  });

  it('tool_call rejects an off-list tool_type', () => {
    const result = ToolCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'tool_call',
      tool: 'Read',
      success: true,
      tool_type: 'managed',
    });
    expect(result.success).toBe(false);
  });
});

describe('prompt', () => {
  it('parses a valid prompt event', () => {
    const result = PromptEventSchema.safeParse({
      ...resourceBase(),
      kind: 'prompt',
      prompt_length: 42,
    });
    expect(result.success).toBe(true);
  });

  it('prompt rejects a negative prompt_length', () => {
    const result = PromptEventSchema.safeParse({
      ...resourceBase(),
      kind: 'prompt',
      prompt_length: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('api_error', () => {
  it('parses a valid api_error event', () => {
    const result = ApiErrorEventSchema.safeParse({
      ...resourceBase(),
      kind: 'api_error',
      error_type: 'rate_limit',
    });
    expect(result.success).toBe(true);
  });

  it('api_error rejects a missing error_type field', () => {
    const result = ApiErrorEventSchema.safeParse({
      ...resourceBase(),
      kind: 'api_error',
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp_server_call', () => {
  it('parses a valid mcp_server_call event', () => {
    const result = McpServerCallEventSchema.safeParse(mcpServerCallBase());
    expect(result.success).toBe(true);
  });

  it('mcp_server_call rejects a missing mcp.method.name field', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'mcp_server_call',
      'mcp_server.call_id': '01HZCALL00000000000000002',
      'gen_ai.tool.name': 'probe',
      'mcp_server.total_ms': 120,
      'mcp_server.status': 'ok',
    });
    expect(result.success).toBe(false);
  });
});

describe('run_start', () => {
  it('parses a valid run_start event', () => {
    const result = RunStartEventSchema.safeParse({
      ...resourceBase(),
      kind: 'run_start',
      rep: 0,
    });
    expect(result.success).toBe(true);
  });

  it('run_start rejects a negative rep', () => {
    const result = RunStartEventSchema.safeParse({
      ...resourceBase(),
      kind: 'run_start',
      rep: -1,
    });
    expect(result.success).toBe(false);
  });
});

describe('run_end', () => {
  it('parses a valid run_end event', () => {
    const result = RunEndEventSchema.safeParse({
      ...resourceBase(),
      kind: 'run_end',
      rep: 0,
      wall_ms: 5000,
      turns: 3,
      tool_calls: 2,
      mcp_server_calls: 0,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      pass: true,
      timed_out: false,
      expected_tools_hit: true,
    });
    expect(result.success).toBe(true);
  });

  it('run_end rejects a missing pass field', () => {
    const result = RunEndEventSchema.safeParse({
      ...resourceBase(),
      kind: 'run_end',
      rep: 0,
      wall_ms: 5000,
      turns: 3,
      tool_calls: 2,
      mcp_server_calls: 0,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      timed_out: false,
      expected_tools_hit: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('ad hoc Session', () => {
  it('parses a model_call carrying only the three resource keys, with run_id absent', () => {
    const result = ModelCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'model_call',
      model: 'claude-sonnet-5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('run_id' in result.data).toBe(false);
    }
  });
});

describe('EventSchema', () => {
  it('rejects an event with an unknown kind, and names kind in the issue path', () => {
    const result = EventSchema.safeParse({
      ...resourceBase(),
      kind: 'telepathy',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('kind'))).toBe(true);
    }
  });
});

describe('ResourceAttributesSchema', () => {
  it('parses with only the three required keys', () => {
    expect(ResourceAttributesSchema.safeParse(resourceBase()).success).toBe(true);
  });

  it('rejects a missing agent', () => {
    const result = ResourceAttributesSchema.safeParse({
      session_id: 'session-1',
      project: 'agent-telemetry-abcd1234',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing session_id', () => {
    const result = ResourceAttributesSchema.safeParse({
      agent: 'claude-code',
      project: 'agent-telemetry-abcd1234',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing project', () => {
    const result = ResourceAttributesSchema.safeParse({
      agent: 'claude-code',
      session_id: 'session-1',
    });
    expect(result.success).toBe(false);
  });
});

describe('mcp_server_call conditional error type', () => {
  it('rejects mcp_server.status "error" without mcp_server.error.type', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...mcpServerCallBase(),
      'mcp_server.status': 'error',
    });
    expect(result.success).toBe(false);
  });

  it('parses mcp_server.status "error" when mcp_server.error.type is present', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...mcpServerCallBase(),
      'mcp_server.status': 'error',
      'mcp_server.error.type': 'upstream_timeout',
    });
    expect(result.success).toBe(true);
  });

  it('keeps an unrecognised mcp_server key in the parsed result', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...mcpServerCallBase(),
      'mcp_server.whatever': 'kept',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['mcp_server.whatever']).toBe('kept');
    }
  });
});

describe('enum closure', () => {
  it('tool_type enum rejects a value outside mcp or native', () => {
    const result = ToolCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'tool_call',
      tool: 'Read',
      success: true,
      tool_type: 'remote',
    });
    expect(result.success).toBe(false);
  });

  it('mcp_server.status enum rejects a value outside ok or error', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...mcpServerCallBase(),
      'mcp_server.status': 'pending',
    });
    expect(result.success).toBe(false);
  });

  it('mcp_server.cache enum rejects a value outside hit, miss, bypass or stale', () => {
    const result = McpServerCallEventSchema.safeParse({
      ...mcpServerCallBase(),
      'mcp_server.cache': 'lukewarm',
    });
    expect(result.success).toBe(false);
  });

  it('ResultsRow cache enum rejects a value outside cold or warm', () => {
    const result = ResultsRowSchema.safeParse({
      ...resultsRowBase(),
      cache: 'tepid',
    });
    expect(result.success).toBe(false);
  });
});

describe('no fabricated zero', () => {
  it('leaves input_tokens absent when the source carries none', () => {
    const result = ModelCallEventSchema.safeParse({
      ...resourceBase(),
      kind: 'model_call',
      model: 'claude-sonnet-5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('input_tokens' in result.data).toBe(false);
    }
  });
});

describe('TaskSchema defaults', () => {
  it('fills timeout_s, expected_tools and tags when the Task file omits them', () => {
    const result = TaskSchema.safeParse(taskBase());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout_s).toBe(600);
      expect(result.data.expected_tools).toEqual([]);
      expect(result.data.tags).toEqual([]);
    }
  });
});

describe('TaskSchema', () => {
  it('parses a valid Task file', () => {
    expect(TaskSchema.safeParse(taskBase()).success).toBe(true);
  });

  it('rejects a Task id containing an uppercase letter', () => {
    const result = TaskSchema.safeParse({ ...taskBase(), id: 'Hello' });
    expect(result.success).toBe(false);
  });
});

describe('VariantsFileSchema', () => {
  it('parses a valid Variants file', () => {
    expect(VariantsFileSchema.safeParse(variantsFileBase()).success).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    const result = VariantsFileSchema.safeParse({ ...variantsFileBase(), extra: true });
    expect(result.success).toBe(false);
  });
});

describe('SessionRowSchema', () => {
  it('parses a valid Session row', () => {
    expect(SessionRowSchema.safeParse(sessionRowBase()).success).toBe(true);
  });

  it('rejects a negative cost_usd', () => {
    const result = SessionRowSchema.safeParse({ ...sessionRowBase(), cost_usd: -1 });
    expect(result.success).toBe(false);
  });
});

describe('ResultsRowSchema', () => {
  it('parses a valid Results row', () => {
    expect(ResultsRowSchema.safeParse(resultsRowBase()).success).toBe(true);
  });

  it('rejects a negative turns count', () => {
    const result = ResultsRowSchema.safeParse({ ...resultsRowBase(), turns: -1 });
    expect(result.success).toBe(false);
  });
});

describe('KindSchema', () => {
  const kinds = [
    'model_call',
    'tool_call',
    'prompt',
    'api_error',
    'mcp_server_call',
    'run_start',
    'run_end',
  ];

  it('accepts each of the seven kind strings', () => {
    for (const kind of kinds) {
      expect(KindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects a kind string outside the seven', () => {
    expect(KindSchema.safeParse('telepathy').success).toBe(false);
  });
});

describe('EventSchema union membership', () => {
  it('parses a valid example of each of the seven kinds through EventSchema', () => {
    const examples = [
      { ...resourceBase(), kind: 'model_call', model: 'claude-sonnet-5' },
      {
        ...resourceBase(),
        kind: 'tool_call',
        tool: 'Read',
        success: true,
        tool_type: 'native',
      },
      { ...resourceBase(), kind: 'prompt', prompt_length: 42 },
      { ...resourceBase(), kind: 'api_error', error_type: 'rate_limit' },
      mcpServerCallBase(),
      { ...resourceBase(), kind: 'run_start', rep: 0 },
      {
        ...resourceBase(),
        kind: 'run_end',
        rep: 0,
        wall_ms: 5000,
        turns: 3,
        tool_calls: 2,
        mcp_server_calls: 0,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        pass: true,
        timed_out: false,
        expected_tools_hit: true,
      },
    ];

    for (const example of examples) {
      const result = EventSchema.safeParse(example);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.kind).toBe(example.kind);
      }
    }
  });
});

describe('ResourceAttributesSchema optional keys', () => {
  it('parses a resource object carrying all four optional keys', () => {
    const result = ResourceAttributesSchema.safeParse({
      ...resourceBase(),
      run_id: '01HZRUN000000000000000001',
      task: 'hello',
      variant: 'none',
      config: 'claude-code+none+cold',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty-string config', () => {
    const result = ResourceAttributesSchema.safeParse({
      ...resourceBase(),
      config: '',
    });
    expect(result.success).toBe(false);
  });
});

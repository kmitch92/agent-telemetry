import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  buildArgs,
  claudeCodeAdapter,
  createClaudeCodeAdapter,
  renderMcpConfig,
  telemetryEnv,
} from '../src/adapters/claude-code.js';
import type { McpServer } from '../src/schema/index.js';

/**
 * Tests for the Claude Code Adapter (SPEC.md:450-472, the Adapter contract
 * and the Claude Code launch vector; docs/agent-events.md for the verified
 * telemetry environment of a live recording).
 */

describe('telemetryEnv', () => {
  it('returns exactly the eight telemetry variables from a live recording', () => {
    const result = telemetryEnv({
      endpoint: 'http://localhost:4318',
      resource: { run_id: '01J', task: 'hello', variant: 'none', config: 'c1' },
    });

    expect(result).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_LOGS_EXPORT_INTERVAL: '1000',
      OTEL_METRIC_EXPORT_INTERVAL: '1000',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J,task=hello,variant=none,config=c1',
    });
  });

  it('never sets OTEL_LOG_USER_PROMPTS, by key, since hard prohibition 3 forbids prompt export', () => {
    const result = telemetryEnv({
      endpoint: 'http://localhost:4318',
      resource: { run_id: '01J', task: 'hello', variant: 'none', config: 'c1' },
    });

    expect(Object.keys(result)).not.toContain('OTEL_LOG_USER_PROMPTS');
  });

  it('carries a different endpoint through, and gives an empty string for an empty resource', () => {
    const result = telemetryEnv({
      endpoint: 'http://collector.internal:4318',
      resource: {},
    });

    expect(result['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://collector.internal:4318');
    expect(result['OTEL_RESOURCE_ATTRIBUTES']).toBe('');
  });
});

describe('launch', () => {
  const spawnCalls: {
    command: string;
    args: string[];
    options: { cwd: string; env: Record<string, string> };
  }[] = [];
  const writeCalls: { path: string; data: string }[] = [];

  const stubChildProcess = {} as unknown as ChildProcess;

  const fakeSpawn = vi.fn(
    (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      spawnCalls.push({ command, args, options });
      // A test fake is the one place a cast is legitimate: the stub is not a
      // real ChildProcess, only a value `launch` must hand back unchanged.
      return stubChildProcess;
    },
  );

  const fakeWriteFileSync = vi.fn((path: string, data: string) => {
    writeCalls.push({ path, data });
  });

  const adapter = createClaudeCodeAdapter({
    spawn: fakeSpawn,
    writeFileSync: fakeWriteFileSync,
  });

  const cwd = '/tmp/agent-telemetry-test/runs/01J/work';
  const env = { PATH: '/usr/bin', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' };
  const mcpServers: McpServer[] = [
    { name: 'probe', command: 'node', args: ['dist/probe.js'], env: { PROBE_LOG: 'error' } },
    { name: 'other', command: 'uvx', args: [], env: {} },
  ];

  const expectedMcpConfigPath = join(dirname(cwd), 'mcp.json');

  const returned = adapter.launch({ prompt: 'say hello', cwd, env, mcpServers });

  it('spawns exactly one process, proving launch never starts a second real process', () => {
    expect(spawnCalls.length).toBe(1);
  });

  it('spawns the command "claude"', () => {
    const [call] = spawnCalls;
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.command).toBe('claude');
    }
  });

  it('builds the exact argument vector, with the mcp config path next to cwd, not inside it', () => {
    const [call] = spawnCalls;
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.args).toEqual([
        '-p',
        'say hello',
        '--output-format',
        'json',
        '--mcp-config',
        expectedMcpConfigPath,
        '--strict-mcp-config',
        '--dangerously-skip-permissions',
      ]);
    }
  });

  it('passes the same cwd and env content through to spawn options', () => {
    const [call] = spawnCalls;
    expect(call).toBeDefined();
    if (call !== undefined) {
      expect(call.options.cwd).toBe(cwd);
      expect(call.options.env).toEqual(env);
    }
  });

  it('writes the mcp config once, to the expected path, with the expected rendered content', () => {
    expect(writeCalls.length).toBe(1);
    const [write] = writeCalls;
    expect(write).toBeDefined();
    if (write !== undefined) {
      expect(write.path).toBe(expectedMcpConfigPath);
      expect(JSON.parse(write.data)).toEqual({
        mcpServers: {
          probe: {
            type: 'stdio',
            command: 'node',
            args: ['dist/probe.js'],
            env: { PROBE_LOG: 'error' },
          },
          other: { type: 'stdio', command: 'uvx', args: [], env: {} },
        },
      });
    }
  });

  it('returns the same stub the fake spawn returned', () => {
    expect(returned).toBe(stubChildProcess);
  });

  it('buildArgs and renderMcpConfig are the pure helpers launch is built from', () => {
    expect(buildArgs({ prompt: 'p', mcpConfigPath: '/x/mcp.json' })).toEqual([
      '-p',
      'p',
      '--output-format',
      'json',
      '--mcp-config',
      '/x/mcp.json',
      '--strict-mcp-config',
      '--dangerously-skip-permissions',
    ]);
    expect(renderMcpConfig([])).toEqual({ mcpServers: {} });
  });
});

describe('transcriptPaths', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-telemetry-adapter-'));
  const projectDir = join(root, '-tmp-fake-work');
  mkdirSync(projectDir, { recursive: true });

  const fixturesDir = join('test', 'fixtures', 'transcripts', 'claude-code');
  const fixtureNames = readdirSync(fixturesDir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort();
  const [firstFixtureName] = fixtureNames;
  expect(firstFixtureName).toBeDefined();

  const oldPath = join(projectDir, 'old.jsonl');
  const newPath = join(projectDir, 'new.jsonl');
  const ignoredPath = join(projectDir, 'ignored.txt');

  if (firstFixtureName !== undefined) {
    copyFileSync(join(fixturesDir, firstFixtureName), oldPath);
    copyFileSync(join(fixturesDir, firstFixtureName), newPath);
  }
  writeFileSync(ignoredPath, 'not a transcript');

  const since = new Date(Date.now() - 60_000);
  const oldTimeSeconds = since.getTime() / 1000 - 3600;
  const newTimeSeconds = Date.now() / 1000;
  utimesSync(oldPath, oldTimeSeconds, oldTimeSeconds);
  utimesSync(newPath, newTimeSeconds, newTimeSeconds);

  const adapter = createClaudeCodeAdapter({ projectsRoot: root });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns only the transcript newer than since, excluding the older one and the non-jsonl file', async () => {
    const result = await adapter.transcriptPaths({ cwd: '/tmp/fake/work', since });
    expect(result).toEqual([newPath]);
  });

  it('returns both transcripts when since predates every mtime', async () => {
    const result = await adapter.transcriptPaths({ cwd: '/tmp/fake/work', since: new Date(0) });
    expect(result.length).toBe(2);
    expect(result).toContain(oldPath);
    expect(result).toContain(newPath);
  });

  it('returns an empty array, without throwing, for an unrelated or missing project directory', async () => {
    const result = await adapter.transcriptPaths({ cwd: '/tmp/not/here', since });
    expect(result).toEqual([]);
  });
});

describe('the Adapter contract', () => {
  it('has exactly four members: launch, name, telemetryEnv, transcriptPaths', () => {
    expect(Object.keys(claudeCodeAdapter).sort()).toEqual([
      'launch',
      'name',
      'telemetryEnv',
      'transcriptPaths',
    ]);
    expect(claudeCodeAdapter.name).toBe('claude-code');
  });
});

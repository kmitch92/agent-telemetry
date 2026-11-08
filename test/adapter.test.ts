import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

const TRANSCRIPT_FIXTURES_DIR = join('test', 'fixtures', 'transcripts', 'claude-code');

/**
 * The 20 harvested Transcript Fixtures are excluded from version control
 * (23 MB) and regenerated locally with `pnpm harvest`, so this read must
 * never throw on a clean clone that lacks them.
 */
function listJsonlFixtureNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
}

const TRANSCRIPT_FIXTURES_USABLE = listJsonlFixtureNames(TRANSCRIPT_FIXTURES_DIR).length > 0;

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

  // A test-only repository root: never the real absolute home-directory
  // path, so no assertion below depends on where this checkout lives.
  const repoRoot = '/fake/repo';
  const fakeFileExists = (path: string) => path === join(repoRoot, 'dist/probe.js');

  const adapter = createClaudeCodeAdapter({
    spawn: fakeSpawn,
    writeFileSync: fakeWriteFileSync,
    repoRoot,
    fileExists: fakeFileExists,
  });

  const cwd = '/tmp/agent-telemetry-test/runs/01J/work';
  const env = {
    PATH: '/usr/bin',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J,task=hello,variant=probe,config=c1',
  };
  const mcpServers: McpServer[] = [
    {
      name: 'probe',
      command: 'node',
      args: ['--verbose', 'dist/probe.js'],
      env: { PROBE_LOG: 'error' },
    },
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

  it('writes the mcp config once, to the expected path, with the same shape renderMcpConfig produces from this launch env, repoRoot and fileExists', () => {
    expect(writeCalls.length).toBe(1);
    const [write] = writeCalls;
    expect(write).toBeDefined();
    if (write !== undefined) {
      expect(write.path).toBe(expectedMcpConfigPath);
      expect(JSON.parse(write.data)).toEqual(
        renderMcpConfig(mcpServers, { repoRoot, inheritEnv: env, fileExists: fakeFileExists }),
      );
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
    expect(
      renderMcpConfig([], { repoRoot: '/fake/repo', inheritEnv: {}, fileExists: () => false }),
    ).toEqual({ mcpServers: {} });
  });
});

describe('launch (relative cwd, the default --runs-root case)', () => {
  it('makes the mcp config path absolute, resolved against repoRoot, when cwd is relative', () => {
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
        return stubChildProcess;
      },
    );

    const fakeWriteFileSync = vi.fn((path: string, data: string) => {
      writeCalls.push({ path, data });
    });

    // A test-only repository root: never the real absolute home-directory
    // path, so no assertion below depends on where this checkout lives.
    const repoRoot = '/fake/repo';
    const fakeFileExists = (path: string) => path === join(repoRoot, 'dist/probe.js');

    const adapter = createClaudeCodeAdapter({
      spawn: fakeSpawn,
      writeFileSync: fakeWriteFileSync,
      repoRoot,
      fileExists: fakeFileExists,
    });

    // Exactly what the Runner hands launch() when --runs-root keeps its
    // relative default: cwd is relative, not rooted at repoRoot.
    const cwd = 'runs/01J/work';
    const env = {
      PATH: '/usr/bin',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J,task=hello,variant=probe,config=c1',
    };
    const mcpServers: McpServer[] = [
      {
        name: 'probe',
        command: 'node',
        args: ['--verbose', 'dist/probe.js'],
        env: { PROBE_LOG: 'error' },
      },
    ];

    const expectedMcpConfigPath = join(repoRoot, 'runs/01J', 'mcp.json');

    adapter.launch({ prompt: 'say hello', cwd, env, mcpServers });

    const [write] = writeCalls;
    expect(write).toBeDefined();
    if (write !== undefined) {
      expect(write.path).toBe(expectedMcpConfigPath);
    }

    const [call] = spawnCalls;
    expect(call).toBeDefined();
    if (call !== undefined) {
      const mcpConfigIndex = call.args.indexOf('--mcp-config');
      expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
      expect(call.args[mcpConfigIndex + 1]).toBe(expectedMcpConfigPath);
      expect(call.options.cwd).toBe(cwd);
    }
  });
});

describe('renderMcpConfig (telemetry env injection and file-arg rewriting)', () => {
  it('injects OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_RESOURCE_ATTRIBUTES, taken from the Agent launch environment, into every server env, and carries no other OTEL_ key', () => {
    const inheritEnv = {
      PATH: '/usr/bin',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J,task=hello',
      OTEL_LOGS_EXPORTER: 'otlp',
    };
    const servers: McpServer[] = [
      { name: 'probe', command: 'node', args: [], env: { PROBE_LOG: 'error' } },
      { name: 'other', command: 'uvx', args: [], env: {} },
    ];

    const result = renderMcpConfig(servers, {
      repoRoot: '/fake/repo',
      inheritEnv,
      fileExists: () => false,
    });

    for (const name of ['probe', 'other']) {
      const serverEnv = result.mcpServers[name]?.env;
      expect(serverEnv).toBeDefined();
      if (serverEnv !== undefined) {
        expect(serverEnv['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://localhost:4318');
        expect(serverEnv['OTEL_RESOURCE_ATTRIBUTES']).toBe('run_id=01J,task=hello');
        const otelKeys = Object.keys(serverEnv)
          .filter((key) => key.startsWith('OTEL_'))
          .sort();
        expect(otelKeys).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_RESOURCE_ATTRIBUTES']);
      }
    }
  });

  it('lets a key already present in the server env win over the injected telemetry value', () => {
    const inheritEnv = {
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J',
    };
    const servers: McpServer[] = [
      {
        name: 'probe',
        command: 'node',
        args: [],
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://pinned:9999', PROBE_LOG: 'error' },
      },
    ];

    const result = renderMcpConfig(servers, {
      repoRoot: '/fake/repo',
      inheritEnv,
      fileExists: () => false,
    });

    expect(result.mcpServers['probe']?.env).toEqual({
      PROBE_LOG: 'error',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://pinned:9999',
      OTEL_RESOURCE_ATTRIBUTES: 'run_id=01J',
    });
  });

  it('rewrites an args entry naming a file that exists relative to the repo root to an absolute path, and leaves a flag or a missing-file entry unchanged', () => {
    const repoRoot = '/fake/repo';
    const existingFile = join(repoRoot, 'dist/probe.js');
    const servers: McpServer[] = [
      {
        name: 'probe',
        command: 'node',
        args: ['--verbose', 'dist/probe.js', 'dist/missing.js'],
        env: {},
      },
    ];

    const result = renderMcpConfig(servers, {
      repoRoot,
      inheritEnv: {},
      fileExists: (path) => path === existingFile,
    });

    expect(result.mcpServers['probe']?.args).toEqual([
      '--verbose',
      existingFile,
      'dist/missing.js',
    ]);
  });
});

describe.skipIf(!TRANSCRIPT_FIXTURES_USABLE)(
  'transcriptPaths (skipped when no harvested Transcript fixture is present; run pnpm harvest)',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-telemetry-adapter-'));
    const projectDir = join(root, '-tmp-fake-work');
    mkdirSync(projectDir, { recursive: true });

    const fixtureNames = listJsonlFixtureNames(TRANSCRIPT_FIXTURES_DIR).sort();
    const [firstFixtureName] = fixtureNames;

    const oldPath = join(projectDir, 'old.jsonl');
    const newPath = join(projectDir, 'new.jsonl');
    const ignoredPath = join(projectDir, 'ignored.txt');

    const since = new Date(Date.now() - 60_000);
    const oldTimeSeconds = since.getTime() / 1000 - 3600;
    const newTimeSeconds = Date.now() / 1000;

    if (firstFixtureName !== undefined) {
      copyFileSync(join(TRANSCRIPT_FIXTURES_DIR, firstFixtureName), oldPath);
      copyFileSync(join(TRANSCRIPT_FIXTURES_DIR, firstFixtureName), newPath);
      utimesSync(oldPath, oldTimeSeconds, oldTimeSeconds);
      utimesSync(newPath, newTimeSeconds, newTimeSeconds);
    }
    writeFileSync(ignoredPath, 'not a transcript');

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
  },
);

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

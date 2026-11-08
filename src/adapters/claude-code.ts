import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync as nodeWriteFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { Adapter } from './index.js';
import type { McpServer } from '../schema/index.js';

/**
 * The Claude Code Adapter (SPEC.md:450-472). Pure helpers
 * (`telemetryEnv`, `renderMcpConfig`, `buildArgs`) carry no `node:*`
 * import; `createClaudeCodeAdapter` is the only place that spawns a
 * process or touches the file system.
 */

/**
 * Builds the eight-variable telemetry environment. These eight names are
 * proved by the live recording documented in
 * `docs/agent-events.md`, and
 * `scripts/record-live.ts:179-188` sets the same set.
 *
 * `OTEL_LOG_USER_PROMPTS` is never set here: hard prohibition 3 in
 * `CLAUDE.md` forbids exporting prompt
 * text, tool input, and tool output, and that variable would export the
 * prompt.
 */
export function telemetryEnv(p: {
  endpoint: string;
  resource: Record<string, string>;
}): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: p.endpoint,
    OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_METRIC_EXPORT_INTERVAL: '1000',
    OTEL_RESOURCE_ATTRIBUTES: Object.entries(p.resource)
      .map(([key, value]) => `${key}=${value}`)
      .join(','),
  };
}

/**
 * Renders the `--mcp-config` file content. The shape here is read from a
 * working Claude Code MCP configuration file on the development machine,
 * and must be re-verified against the installed version before it is
 * trusted: `claude --help` documents only "Load MCP servers from JSON
 * files or strings (space-separated)", not the file's internal shape.
 *
 * Pure: the existence check and the repo root both arrive through `opts`,
 * so this function carries no `node:*` import.
 */
export function renderMcpConfig(
  servers: McpServer[],
  opts: {
    repoRoot: string;
    inheritEnv: Record<string, string>;
    fileExists: (path: string) => boolean;
  },
): {
  mcpServers: Record<
    string,
    { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  >;
} {
  const { repoRoot, inheritEnv, fileExists } = opts;

  // SPEC.md:541: `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_EXPORTER_OTLP_ENDPOINT`
  // are the two variables a Collector resource needs, so every MCP server
  // gets the same two values the Agent launch environment carries, letting
  // the server's own events share the Run's resource attributes and reach
  // the same Collector endpoint.
  const telemetryEnvForServer: Record<string, string> = {};
  if (inheritEnv['OTEL_EXPORTER_OTLP_ENDPOINT'] !== undefined) {
    telemetryEnvForServer['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      inheritEnv['OTEL_EXPORTER_OTLP_ENDPOINT'];
  }
  if (inheritEnv['OTEL_RESOURCE_ATTRIBUTES'] !== undefined) {
    telemetryEnvForServer['OTEL_RESOURCE_ATTRIBUTES'] = inheritEnv['OTEL_RESOURCE_ATTRIBUTES'];
  }

  const mcpServers: Record<
    string,
    { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  > = {};

  for (const server of servers) {
    // SPEC.md:412-413 fixes `cwd` as `runs/<run_id>/work`, so an MCP server
    // spawned with that `cwd` cannot resolve a repository-relative args
    // path the way a process spawned from the repository root could; this
    // rewrites such a path to an absolute one before it is written out.
    const args = server.args.map((arg) => {
      const absolute = join(repoRoot, arg);
      return fileExists(absolute) ? absolute : arg;
    });

    mcpServers[server.name] = {
      type: 'stdio',
      command: server.command,
      args,
      env: { ...telemetryEnvForServer, ...server.env },
    };
  }

  return { mcpServers };
}

/**
 * Builds the launch argument vector. The flag source: the primary
 * session ran `claude --help` on version 2.1.270, and
 * `docs/agent-events.md:498-523` quote the
 * output verbatim. `--allow-dangerously-skip-permissions` is a different
 * flag that only offers the bypass as an option without enabling it, so
 * this adapter must not use it.
 */
export function buildArgs(p: { prompt: string; mcpConfigPath: string }): string[] {
  return [
    '-p',
    p.prompt,
    '--output-format',
    'json',
    '--mcp-config',
    p.mcpConfigPath,
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
  ];
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => ChildProcess;

type WriteFileSyncFn = (path: string, data: string) => void;

/**
 * The factory's injection pattern follows
 * `src/ulid.ts:43-49`: each dependency is
 * optional and falls back with `??` to the real one.
 */
export function createClaudeCodeAdapter(deps?: {
  spawn?: SpawnFn;
  writeFileSync?: WriteFileSyncFn;
  projectsRoot?: string;
  repoRoot?: string;
  fileExists?: (path: string) => boolean;
}): Adapter {
  const spawn = deps?.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const writeFileSync = deps?.writeFileSync ?? nodeWriteFileSync;
  const projectsRoot = deps?.projectsRoot ?? join(homedir(), '.claude', 'projects');
  const repoRoot = deps?.repoRoot ?? process.cwd();
  const fileExists = deps?.fileExists ?? existsSync;

  return {
    name: 'claude-code',

    launch({ prompt, cwd, env, mcpServers }) {
      // SPEC.md:412-413 fixes `cwd` as `runs/<run_id>/work`, so the parent
      // of `cwd` is the Run directory: this is where the mcp config file
      // lives, next to `cwd`, never inside it. The Agent process resolves
      // a relative `--mcp-config` argument against its own cwd, which
      // SPEC.md:412-413 fixes as `runs/<run_id>/work`, so a relative path
      // here would double: a real bench Run proved this, the Agent
      // printed "MCP config file not found:
      // .../runs/<run_id>/work/runs/<run_id>/mcp.json". `resolve` against
      // `repoRoot` fixes this: an absolute later segment discards the
      // earlier ones, so an already-absolute `cwd` yields the same path
      // it does today, while a relative `cwd` yields an absolute one.
      const mcpConfigPath = resolve(repoRoot, dirname(cwd), 'mcp.json');

      const mcpConfig = renderMcpConfig(mcpServers, { repoRoot, inheritEnv: env, fileExists });
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

      return spawn('claude', buildArgs({ prompt, mcpConfigPath }), { cwd, env });
    },

    telemetryEnv(p) {
      return telemetryEnv(p);
    },

    async transcriptPaths({ cwd, since }) {
      // Claude Code names a project directory after the working directory,
      // with every `/` replaced by `-`: the working directory `/a/b/c`
      // becomes the project directory `-a-b-c`. Whether a `.` in a path
      // also becomes `-` is unverified, because hard prohibition 2 in
      // CLAUDE.md forbids listing `~/.claude`, so this adapter does not
      // guess at that case.
      const encodedName = cwd.replace(/\//g, '-');
      const projectDir = join(projectsRoot, encodedName);

      let entries;
      try {
        entries = await readdir(projectDir, { withFileTypes: true });
      } catch {
        // A missing (or otherwise unreadable) project directory simply
        // means no Transcript has been written yet for this cwd.
        return [];
      }

      const paths: string[] = [];
      for (const entry of entries) {
        // Files one level down only, never deeper: per
        // `scripts/harvest-transcripts.ts:170-176`,
        // a file nested a level further down is a subagent Transcript
        // carrying its parent Session's identifier.
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          continue;
        }
        const filePath = join(projectDir, entry.name);
        const fileStat = await stat(filePath);
        if (fileStat.mtimeMs >= since.getTime()) {
          paths.push(filePath);
        }
      }

      return paths;
    },
  };
}

/** The default Claude Code Adapter, built with every real dependency. */
export const claudeCodeAdapter: Adapter = createClaudeCodeAdapter();

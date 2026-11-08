import type { ChildProcess } from 'node:child_process';

import type { McpServer } from '../schema/index.js';

/**
 * The Adapter contract (SPEC.md:450-460): an Adapter is the only
 * Agent-specific code the Runner holds, and it has exactly these four
 * members.
 *
 * - `name`: the Adapter's own identifier, e.g. `'claude-code'`.
 * - `launch`: starts one real Agent process for one Run and returns the
 *   `ChildProcess` unchanged, so the Runner can pipe its output.
 * - `telemetryEnv`: builds the environment variables that turn on OTLP
 *   telemetry and stamp the Run's resource attributes.
 * - `transcriptPaths`: resolves the absolute paths of the Transcript files
 *   an Agent wrote for one Run's working directory, at or after `since`.
 */
export type Adapter = {
  name: string;
  launch(p: {
    prompt: string;
    cwd: string;
    env: Record<string, string>;
    mcpServers: McpServer[];
  }): ChildProcess;
  telemetryEnv(p: { endpoint: string; resource: Record<string, string> }): Record<string, string>;
  transcriptPaths(p: { cwd: string; since: Date }): Promise<string[]>;
};

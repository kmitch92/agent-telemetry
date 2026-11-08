# Adding an Agent

This guide states every step and every fact a contributor must verify before a second Agent is considered supported. The only Agent verified on this machine is Claude Code 2.1.270. No step below may be skipped on the grounds that another Agent behaves a certain way.

## The steps

1. **Confirm the Agent is installed, and record the version.** Run the Agent's own `--version` flag. Record the exact output string in `docs/agent-events.md`. If the command reports "command not found", stop: the Agent cannot be added from this machine.

2. **Find the headless launch flags.** Run the Agent's own `--help` flag and read it. Never assume a flag from another Agent. Quote the help text verbatim into `docs/agent-events.md`, as the Claude Code section does, and name any near-miss flag you rejected and why.

3. **Find or enable the OpenTelemetry export switches, and point them at `http://localhost:4318`.** The Collector listens on that address for OTLP over HTTP. Record every environment variable name and value in `docs/agent-events.md`. If the Agent has no OpenTelemetry export, stop and report, because this system never sits in an Agent's request path, which hard prohibition 1 in CLAUDE.md forbids.

4. **Confirm whether `OTEL_RESOURCE_ATTRIBUTES` is honoured.** Run `pnpm record` once with a known `run_id`, then inspect the recorded Events for that `run_id` on the resource attributes. `pnpm record` starts a real Agent session and costs money, so run it only when the user asks for that specific run. If the attributes are absent, document that the Agent takes the fallback path in SPEC.md lines 478 to 481, where the Runner matches the Session by its start and end time window.

5. **Locate the Agent's own Session identifier attribute.** Find the attribute key the Agent stamps on every Event to identify one Session. Record the key, with one example value shape, in `docs/agent-events.md`.

6. **Locate the Transcript files on disk, for the Replayer's harvest step.** Record the directory pattern and the file extension. Read Transcript files only; hard prohibition 2 in CLAUDE.md forbids every other access under `~/.claude`, `~/.codex`, and `~/.gemini`.

7. **Confirm the Agent never logs prompt text by default, and keep it that way.** Inspect the recorded Events for prompt text, tool input, and tool output. Name the switch that would enable prompt logging and state that it stays unset, as `OTEL_LOG_USER_PROMPTS` stays unset for Claude Code. Hard prohibition 3 in CLAUDE.md forbids exporting any of the three.

8. **Add the three required pieces, each backed by a passing test against a real recording.** Add one new Adapter implementation file in `/home/kiel/dev/agent-telemetry/src/adapters/`, named after the Agent, exporting a value of the `Adapter` type. Add one parser in `/home/kiel/dev/agent-telemetry/src/replayer/parsers/`, and one section in `/home/kiel/dev/agent-telemetry/docs/agent-events.md`. Commit a redacted real recording as a fixture under `/home/kiel/dev/agent-telemetry/test/fixtures/`. SPEC.md line 501 also requires one row in the Adapter's internal registry. No registry module exists today, because `/home/kiel/dev/agent-telemetry/src/adapters/index.ts` holds the `Adapter` type and nothing else, per the adapter ticket in `/home/kiel/dev/agent-telemetry/tickets.yaml`. The contributor who adds the second Agent creates that registry, and the Runner then resolves an Agent name through it. Until all the pieces exist and the test passes, the Agent is not supported.

## The Adapter contract

An Adapter is the only Agent-specific code in the Runner. It has exactly four members and nothing else:

```ts
type Adapter = {
  name: string; // e.g. 'claude-code'; see docs/adding-an-agent.md to add another
  launch(p: { prompt: string; cwd: string; env: Env; mcpServers: McpServer[] }): ChildProcess;
  telemetryEnv(p: { endpoint: string; resource: Record<string, string> }): Env;
  transcriptPaths(p: { cwd: string; since: Date }): Promise<string[]>;
};
```

- `name` returns the Adapter's own identifier string, for example `claude-code`.
- `launch` returns the spawned child process for one Agent Session, given the prompt, working directory, environment, and MCP servers to register.
- `telemetryEnv` returns the environment variables that point the Agent's telemetry export at the given endpoint and stamp the given resource attributes.
- `transcriptPaths` returns the list of Transcript file paths written since the given time, for the given working directory.

For `launch`, the Claude Code implementation writes the MCP configuration file into the Run directory itself, because SPEC.md lines 412 and 413 fix `cwd` as `runs/<run_id>/work`, so the Run directory is the parent of `cwd`.

## Agents without an Adapter

- `codex` and `gemini` are not installed on this machine. Running `codex --version` and `gemini --version` both report command not found, as SPEC.md lines 507 and 508 record.
- Neither Agent has an Adapter. `/home/kiel/dev/agent-telemetry/src/adapters/` holds one implementation only, `claude-code.ts`.
- This repository claims no event name, no attribute key, no launch flag, and no telemetry switch for either Agent, because no live recording exists to verify any of it.
- Until a contributor follows the eight steps above and commits a live recording, no Adapter, no mapping table row, and no dashboard panel may reference either Agent. See SPEC.md lines 505 to 513.

## Limits of the Claude Code Adapter

- The `--mcp-config` file shape is an inference. The evidence is a working `.mcp.json` that Claude Code consumes, not the output of `claude --help`.
- The combination of `-p` and `--dangerously-skip-permissions` is unproved, because proving it starts a paid session.
- Whether a `.` in a working directory path encodes to `-` in the Transcript directory name is unverified, because hard prohibition 2 forbids listing `~/.claude`.

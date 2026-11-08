# Claude Code Events, as observed

This file records what one live Claude Code Session emitted into the
Collector. It is drawn from a single recording, and nothing else. A claim
absent from this file was not observed here, not disproved.

## The recording

The recording ran this command, verbatim:

```
claude -p "List the files in this directory, then stop." \
  --output-format json \
  --allowedTools "Bash(ls:*)"
```

`--allowedTools "Bash(ls:*)"` was added to the ticket's plain command so a
real tool call could happen in a headless Session.
`--dangerously-skip-permissions` was NOT used. The Session ran in a
disposable scratch Project holding exactly two dummy files.

The telemetry environment, verbatim:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
OTEL_LOGS_EXPORT_INTERVAL=1000
OTEL_METRIC_EXPORT_INTERVAL=1000
OTEL_RESOURCE_ATTRIBUTES=run_id=probe
```

`OTEL_LOG_USER_PROMPTS` was never set, per SPEC.md:483. The recording script
aborts before spawning anything if it finds that variable set.

## Host facts

These were all measured on 2026-11-08 on the recording host.

| Fact                     | Value                                            |
| ------------------------ | ------------------------------------------------ |
| Operating system         | Ubuntu 26.04 LTS                                 |
| Kernel                   | `Linux 7.0.0-38-generic x86_64`                  |
| Shell                    | `/bin/zsh`                                       |
| `claude --version`       | `2.1.270 (Claude Code)`                          |
| `codex`                  | not installed                                    |
| `gemini`                 | not installed                                    |
| `docker compose version` | `2.40.3-desktop.1`                               |
| `node --version`         | `v22.18.0`                                       |
| `pnpm --version`         | `10.31.0`                                        |
| Transcript count         | 542 `*.jsonl` files across 7 Project directories |

The `harvest` ticket text records 484 Transcript files. The observed count on
2026-11-08 was 542. The count grows as Sessions run, so the ticket number was
not changed.

## Where the Event name lives

In every captured log record the Event name lives in an ATTRIBUTE whose key
is `event.name`. The OTLP log record field `eventName` was empty on every
captured record, so a Normaliser that reads `eventName` finds nothing.

The observed names carry NO `claude_code.` prefix. The observed name is
`api_request`, not `claude_code.api_request`. SPEC.md:252 records
`claude_code.api_request` as the source name. This is a contradiction between
SPEC.md and the recording. This document records the observation. It does
not change SPEC.md, and it does not pick a side.

## Observed Event names

These are the complete counts from the recording's seven captured
`resourceLogs` lines, holding 39 log records in total.

| Event name                | Records | Name source            |
| ------------------------- | ------- | ---------------------- |
| `api_request`             | 2       | `event.name` attribute |
| `assistant_response`      | 1       | `event.name` attribute |
| `hook_execution_complete` | 3       | `event.name` attribute |
| `hook_execution_start`    | 3       | `event.name` attribute |
| `hook_registered`         | 11      | `event.name` attribute |
| `mcp_server_connection`   | 16      | `event.name` attribute |
| `tool_decision`           | 1       | `event.name` attribute |
| `tool_result`             | 1       | `event.name` attribute |
| `user_prompt`             | 1       | `event.name` attribute |

## Attribute keys per Event name

### `api_request`

```
cache_creation_tokens, cache_read_tokens, client_request_id, cost_usd,
cost_usd_micros, duration_ms, effort, event.name, event.sequence,
event.timestamp, input_tokens, model, organization.id, output_tokens,
prompt.id, query_source, request_id, run_id, session.id, speed,
terminal.type, ttft_ms, user.account_id, user.account_uuid, user.email,
user.id
```

### `assistant_response`

```
event.name, event.sequence, event.timestamp, message.uuid, model,
organization.id, prompt.id, query_source, request_id, response,
response_length, run_id, session.id, terminal.type, user.account_id,
user.account_uuid, user.email, user.id
```

### `hook_execution_complete`

```
event.name, event.sequence, event.timestamp, hook_event, hook_name,
hook_source, managed_only, num_blocking, num_cancelled, num_hooks,
num_non_blocking_error, num_success, organization.id, prompt.id, run_id,
safe_mode, session.id, terminal.type, total_duration_ms, user.account_id,
user.account_uuid, user.email, user.id
```

### `hook_execution_start`

```
event.name, event.sequence, event.timestamp, hook_event, hook_name,
hook_source, managed_only, num_hooks, organization.id, prompt.id, run_id,
safe_mode, session.id, terminal.type, user.account_id, user.account_uuid,
user.email, user.id
```

### `hook_registered`

```
event.name, event.sequence, event.timestamp, hook_event, hook_source,
hook_type, organization.id, run_id, safe_mode, session.id, terminal.type,
user.account_id, user.account_uuid, user.email, user.id
```

### `mcp_server_connection`

```
duration_ms, event.name, event.sequence, event.timestamp, is_plugin,
organization.id, prompt.id, run_id, server_scope, session.id, status,
terminal.type, transport_type, user.account_id, user.account_uuid,
user.email, user.id
```

### `tool_decision`

```
decision, event.name, event.sequence, event.timestamp, organization.id,
prompt.id, run_id, session.id, source, terminal.type, tool_name,
tool_source, tool_use_id, user.account_id, user.account_uuid, user.email,
user.id
```

### `tool_result`

```
duration_ms, event.name, event.sequence, event.timestamp, organization.id,
prompt.id, run_id, session.id, success, terminal.type,
tool_input_size_bytes, tool_name, tool_result_size_bytes, tool_use_id,
user.account_id, user.account_uuid, user.email, user.id
```

### `user_prompt`

```
event.name, event.sequence, event.timestamp, message.uuid,
organization.id, prompt, prompt.id, prompt_length, run_id, session.id,
terminal.type, user.account_id, user.account_uuid, user.email, user.id
```

### Resource-level attribute keys

```
host.arch, os.type, os.version, run_id, service.name, service.version
```

## The Session identifier

The exact attribute carrying the Claude Code Session identifier is
`session.id`. The recording script matched it by comparing every captured
attribute's string value against the identifier `claude --output-format
json` printed on stdout. `session.id` was the only key whose value matched.
Its value was a 36-character identifier, which is the length of a
hyphenated UUID.

SPEC.md:252 and SPEC.md:276-278 record `session.id` as a starting point
requiring verification against a live recording. The recording CONFIRMS it.

The identifier itself was never written to any file. The Fixture carries
only its SHA-256 hash, reshaped to the 8-4-4-4-12 form by `src/hash.ts`.

## OTEL_RESOURCE_ATTRIBUTES

`OTEL_RESOURCE_ATTRIBUTES` WAS honoured. The recording set
`OTEL_RESOURCE_ATTRIBUTES=run_id=probe`, and a resource-level attribute with
key `run_id` and string value `probe` appeared on the captured Events. So
the fallback that SPEC.md:478-481 describes is not needed for Claude Code
2.1.270.

The recording script does not rely on that variable anyway. It records the
Collector sink's byte length before spawning the Agent and reads only the
bytes appended after it, because one Session owns the Collector for its
duration. That byte window would have identified the Session even had the
variable been ignored.

### The bench Runs

Two Runs ran under `bench` on Claude Code 2.1.270 on 2026-11-08, both
passing their Checker: run_id `01M6XBRR7D3EWX8KEE9B2S5YTX` (task `hello`,
variant `none`, turns 6, Agent Session
`c00c6494-ed72-4203-9a1d-88c61676675b`), and run_id
`01M6XBSWDJAT1F6080VC650MQ5` (task `hello-probe`, variant `probe`, turns 4,
Agent Session `53e47aaf-8648-407c-ba6d-894d79f556e6`).

The Agent's own Events carried `run_id`, `task`, `variant` and `config` as
resource attributes in both Runs. So Claude Code 2.1.270 takes the resource
attribute path, and the time-window fallback of SPEC.md:478-481 is neither
implemented nor needed.

The Runner must also supply `project_path` in `OTEL_RESOURCE_ATTRIBUTES`.
Without it the Collector derives no `project` attribute, and every Agent
Event then fails EventSchema with "project: Invalid input: expected string,
received undefined". A first Run passed its Checker but reported `turns=0`
for exactly this reason.

The Probe Server's `mcp_server_call` Event carried the same run_id,
`01M6XBSWDJAT1F6080VC650MQ5`. The route: the Adapter writes
`OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_RESOURCE_ATTRIBUTES` into the
per-Run `mcp.json` env block, and the `claude` process passes that env to
the stdio MCP server, which reads both with `createOtlpSender`. Whether
`claude` would also forward its own environment without that injection is
unverified: the injection was in place for every Run measured.

Claude Code 2.1.270 does not export the MCP tool's real name. The
`tool_call` Event for the probe tool carried `tool="mcp_tool"` and
`tool_type="native"`. The name `mcp__probe__probe` never appeared in any
Event. The Collector rule at compose/collector/config.yaml:79-83 tests
`IsMatch(tool, "^mcp__")`, so it never fires, and no `tool_call` Event
carries `tool_type="mcp"` or `mcp_server="probe"`. The MCP server name is
therefore not recoverable from the Agent's own telemetry on this version.
This is an open gap, not a solved item.

## Prompt and response text

The `user_prompt` Event carries an attribute with key `prompt`, and the
`assistant_response` Event carries one with key `response`. With
`OTEL_LOG_USER_PROMPTS` unset, BOTH values were the literal 10-character
string `<REDACTED>`, not the text. The prompt actually sent was 43
characters long, so Claude Code redacts these itself when the switch is
off. The repository's own redactor replaces both anyway, because `prompt`
and `response` are not in its keep-set, so the protection is doubled.

## Personal data in the capture

The captured Events carry attributes identifying a person and an account:
`user.email`, `user.id`, `user.account_id`, `user.account_uuid` and
`organization.id`. None is in the redactor's keep-set, so each is replaced
by a same-length placeholder in the Fixture. The Collector's own sink file
is therefore an unredacted capture by nature, which is why `data/` is
excluded from version control.

## What the redactor keeps, and why

`KEEP_NAMES` in `src/redact.ts` was extended exactly once after this
recording, and ONLY with keys this recording showed.

| Key               | Observed values                                                                        | Why it is kept                                                           |
| ----------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `event.timestamp` | ISO-8601 instants, for example `2026-11-08T02:40:27.673Z`                              | the ticket requires timestamps to survive                                |
| `tool_name`       | `Bash`                                                                                 | the ticket requires tool names, including any `mcp__` prefix, to survive |
| `tool_source`     | `builtin`                                                                              | distinguishes a built-in tool from an MCP server tool                    |
| `decision`        | `accept`                                                                               | the permission outcome of a tool call                                    |
| `source`          | `config`                                                                               | where the tool decision came from                                        |
| `status`          | `connected`, `disconnected`                                                            | the MCP server connection outcome                                        |
| `transport_type`  | `stdio`, `claudeai-proxy`                                                              | the MCP server transport                                                 |
| `server_scope`    | `user`, `claudeai`                                                                     | where the MCP server is configured                                       |
| `hook_event`      | `SessionStart`, `PreToolUse`, `UserPromptSubmit`, `PreCompact`, `Stop`, `SubagentStop` | the hook lifecycle point                                                 |
| `hook_name`       | `SessionStart:startup`, `UserPromptSubmit`, `Stop`                                     | a lifecycle label, carrying no command text                              |
| `hook_source`     | `merged`, `userSettings`                                                               | which settings layer registered the hook                                 |
| `hook_type`       | `command`                                                                              | the hook mechanism                                                       |
| `query_source`    | `main`, `sdk`                                                                          | which entry point issued the model call                                  |
| `effort`          | `high`                                                                                 | the reasoning effort of the model call                                   |
| `speed`           | `normal`                                                                               | the speed mode of the model call                                         |
| `safe_mode`       | `false`                                                                                | a boolean encoded as a string                                            |
| `managed_only`    | `false`                                                                                | a boolean encoded as a string                                            |
| `terminal.type`   | `tmux`                                                                                 | the host terminal, a bounded category                                    |
| `service.version` | `2.1.270`                                                                              | the Agent version                                                        |
| `os.type`         | `linux`                                                                                | host dimension                                                           |
| `os.version`      | `7.0.0-38-generic`                                                                     | host dimension                                                           |
| `host.arch`       | `amd64`                                                                                | host dimension                                                           |

Every one of those values was inspected before the key was added. Each is a
bounded category, a version, or a timestamp, and none carried a path or
user content. `event.sequence` and `is_plugin` were deliberately NOT added,
because OTLP encodes them in an `intValue` or `boolValue` wrapper, and the
redactor already keeps such a value without a keep-set entry.

## Which counts survive redaction, and which needed a keep-set entry

OTLP JSON encodes a 64-bit integer as a JSON string inside an `intValue`
wrapper, and a float inside a `doubleValue` wrapper.
`src/redact.ts:119-125` keeps a value found directly under `intValue`,
`doubleValue` or `boolValue`, whatever its attribute key. On
`api_request`, Claude Code does use those wrappers: `input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_creation_tokens`,
`duration_ms`, `ttft_ms` and `cost_usd_micros` arrive as `intValue`, and
`cost_usd` arrives as `doubleValue`. Those all survived with no
keep-set entry. That part of the earlier claim on this section holds.

The earlier claim was wrong for three keys. Claude Code does NOT use a
numeric wrapper everywhere. On `user_prompt` it sends `prompt_length`
as a `stringValue`. On `tool_result` it sends `success`, `duration_ms`,
`tool_input_size_bytes` and `tool_result_size_bytes` as a `stringValue`.
On `mcp_server_connection` it sends `duration_ms` as a `stringValue`.
`stringValue` is in `TRANSPARENT_NAMES` (`src/redact.ts:117`), so the
attribute key becomes the name context, and `policyFor`
(`src/redact.ts:94-102`) redacts anything absent from `KEEP_NAMES`. The
first Fixture therefore held the placeholder `"xx"` for
`prompt_length`, `"xxxx"` for `duration_ms` and `"xxx"` for
`tool_result_size_bytes`.

The fix: `KEEP_NAMES` gained exactly three entries, `prompt_length`,
`duration_ms` and `tool_result_size_bytes` (`src/redact.ts:81-84`).
Each is a count, and no path or user content can appear under those
names. `tool_input_size_bytes` was deliberately NOT added, because no
Event field consumes it.

## The Fixture

The Fixture is `test/fixtures/events/claude-code/01.jsonl`. It holds 7
lines, each an OTLP `resourceLogs` envelope, together carrying 39 log
records. Every line parses as JSON. It contains no absolute path, no
email address and no prompt text.

The Collector exports logs, metrics and traces to one file, per
`compose/collector/config.yaml:141-152`. The recording's appended
window held 7 `resourceLogs` lines, 3 `resourceMetrics` lines and 0
`resourceSpans` lines. Only the `resourceLogs` lines reached the
Fixture.

The recording script wrote the Fixture once, under the keep-set as it
stood before the recording. That first pass blanked structural keys the
recording then showed were worth keeping, `tool_name` among them, so
`Bash` became a placeholder. After `KEEP_NAMES` was extended with those
structural keys, the Fixture was rebuilt by re-redacting the SAME
captured lines out of the Collector's sink. No second Agent Session was
started, so the recording cost one paid Session in total. That rebuild
skipped the sink's first line, which came from the operator script
`scripts/send-test-event.ts` and not from an Agent. After it, the kept
values were present: `Bash` under `tool_name`, `probe` under `run_id`,
`connected` under `status`, `accept` under `decision`, `2.1.270` under
`service.version`, and `linux` under `os.type`.

A second rebuild followed, once `KEEP_NAMES` gained `prompt_length`,
`duration_ms` and `tool_result_size_bytes`. The operator script
`scripts/rebuild-fixture.ts` performed it, reading the recording
already on disk and spawning no Agent, so this rebuild cost nothing.
The script selects a line by its OTLP scope name
`com.anthropic.claude_code.events`, which is what separates the real
recording from the synthetic line `scripts/send-test-event.ts` writes
under the scope name `agent-telemetry`. The rebuild changed exactly 19
attribute values and nothing else: `prompt_length` `"xx"` became
`"44"`, `tool_result_size_bytes` `"xxx"` became `"196"`, and 17
`duration_ms` values became their real counts, among them `"1168"` on
`tool_result`. The hashed `session.id` did not change, which shows the
rebuild is reproducible from the same capture. The Fixture still holds
7 lines, 39 log records, no absolute path, no email address and no
prompt text.

Redaction is NOT idempotent, and that is by design. A name whose policy
is `hash` is hashed again on a second pass, so the hashed Session
identifier changes each time redaction runs. Everything else is stable:
a kept value stays identical, and a placeholder re-redacts to a
placeholder of the same length. A test proves this by masking every
8-4-4-4-12 hexadecimal run in both the Fixture line and its
re-redaction, then comparing the two masked strings.

## Metrics observed

The same sink received metrics. The four observed metric names:

```
claude_code.active_time.total
claude_code.cost.usage
claude_code.session.count
claude_code.token.usage
```

No ticket consumes these yet, so they are recorded and not mapped.

## What the Normaliser produces from the Fixture

Posting the 7 Fixture lines to the running Collector and classifying
the output gives 4 `event` outcomes, 0 `unknown_kind` outcomes and 0
`malformed` outcomes: two `model_call`, one `tool_call` and one
`prompt`. The other 35 records are dropped; see "The verified mapping",
next, for which six names and why.

The resource of every output record carries `agent` `claude-code`,
`session_id` as the hashed Session identifier, and `project`
`probe-project-58268c63`, and carries NO `project_path`.

The integration test is `test/normaliser.integration.test.ts`, and it
skips rather than fails when the Stack is not running.

## The verified mapping

### Kind mapping

Every row below is implemented at the cited line of
`compose/collector/config.yaml` and proven by the integration test.

| `event.name`      | Kind         | Evidence                       |
| ----------------- | ------------ | ------------------------------- |
| `api_request`      | `model_call` | `compose/collector/config.yaml:40` |
| `tool_result`      | `tool_call`  | `compose/collector/config.yaml:41` |
| `user_prompt`      | `prompt`     | `compose/collector/config.yaml:42` |
| `runner.run_start` | `run_start`  | `compose/collector/config.yaml:43` |
| `runner.run_end`   | `run_end`    | `compose/collector/config.yaml:44` |

The `runner.*` rows come from `SPEC.md:256-257` and are NOT proven by
any recording, because the Runner does not exist yet.
`compose/collector/config.yaml` is the only file in the repository
that knows an Agent's own event name, per `SPEC.md:221`.

### Attribute mapping

Every row below is taken from `compose/collector/config.yaml:61-71`
and `:79-83`.

| Kind         | Target field        | Source attribute         | Conversion                                |
| ------------ | -------------------- | ------------------------- | ------------------------------------------ |
| `model_call` | `duration_ms`         | `duration_ms`              | `Int`, guarded by `IsMatch`                 |
| `model_call` | `input_tokens`        | `input_tokens`             | `Int`, guarded by `IsMatch`                 |
| `model_call` | `output_tokens`       | `output_tokens`            | `Int`, guarded by `IsMatch`                 |
| `model_call` | `cache_read_tokens`   | `cache_read_tokens`        | `Int`, guarded by `IsMatch`                 |
| `model_call` | `cache_write_tokens`  | `cache_creation_tokens`    | `Int`, guarded by `IsMatch`                 |
| `model_call` | `cost_usd`            | `cost_usd`                 | `Double`, guarded by `IsMatch`              |
| `model_call` | `reasoning_tokens`    | (none)                     | stays unset, Claude Code exposes none       |
| `tool_call`  | `tool`                | `tool_name`                | set when `tool_name` is not nil             |
| `tool_call`  | `success`             | `success`                  | `Bool`, guarded by `IsMatch`                |
| `tool_call`  | `duration_ms`         | `duration_ms`              | `Int`, guarded by `IsMatch`                 |
| `tool_call`  | `result_bytes`        | `tool_result_size_bytes`   | `Int`, guarded by `IsMatch`                 |
| `tool_call`  | `tool_type`           | `tool` (derived)           | `native`, then `mcp` if `tool` matches `^mcp__` |
| `tool_call`  | `mcp_server`          | `tool` (derived)           | copied, `mcp__` prefix and `__...` suffix stripped; unset for a native tool |
| `prompt`     | `prompt_length`       | `prompt_length`            | `Int`, guarded by `IsMatch`                 |

`reasoning_tokens` on `model_call` stays unset because Claude Code does
not expose it, and `mcp_server` stays unset for a native tool. Every
numeric conversion carries an `IsMatch` guard, so a value that does not
parse leaves the target unset rather than writing text into a numeric
field, because `error_mode: ignore` would otherwise skip the failed
conversion silently. `project` is derived as
`<basename>-<first 8 hex of sha256 of the absolute path>` per
`SPEC.md:227-228`, from a `project_path` resource attribute the
launcher supplies through `OTEL_RESOURCE_ATTRIBUTES`, and
`compose/collector/config.yaml:35` deletes `project_path` so no
absolute path reaches Loki or `events.jsonl`.

The second test in `test/normaliser.integration.test.ts` posts a
synthetic envelope through three tool names and confirms this parse:
`mcp__claude_ai_Gmail__search_threads` yields `tool_type` `mcp` and
`mcp_server` `claude_ai_Gmail`, `mcp__context7__query-docs` yields
`tool_type` `mcp` and `mcp_server` `context7`, and `Read` yields
`tool_type` `native` with no `mcp_server` set. The first result is
the one that matters: it shows the server name keeps its own
underscore rather than being cut at the first one.

### Six observed names left deliberately unmapped

| `event.name`              | Records | Reason                                                           |
| ------------------------- | ------- | ----------------------------------------------------------------- |
| `mcp_server_connection`   | 16      | a connection outcome, not a call. `mcp_server_call` requires `mcp_server.call_id`, `mcp.method.name`, `gen_ai.tool.name`, `mcp_server.total_ms` and `mcp_server.status` (`src/schema/events.ts:87-91`), and all five would be fabricated. |
| `hook_registered`         | 11      | no analogue in the Kind union.                                     |
| `hook_execution_start`    | 3       | no analogue in the Kind union.                                     |
| `hook_execution_complete` | 3       | no analogue in the Kind union.                                     |
| `tool_decision`           | 1       | carries `decision`, not the `success` boolean `tool_call` requires (`src/schema/events.ts:35`). |
| `assistant_response`      | 1       | carries `model` but no token counts, so mapping it to `model_call` would double-count every model call. |

`tickets.yaml:386` forbids fabricating a value. `tickets.yaml:388` and
`SPEC.md:261` require an unknown event name to pass through with
`kind` unset. `SPEC.md:267-269` and the ticket's own acceptance
criterion require the unknown kind count for `claude-code` to be
exactly 0. Those three rules cannot all hold for a name that has no
Kind, so `compose/collector/config.yaml:55` marks these six by name
and the `filter/unmapped` processor at
`compose/collector/config.yaml:106-109` drops them. A name on neither
list still passes through with `kind` unset, so the pass-through rule
survives for a future Agent version.

`api_error` and `mcp_server.call` get no statement at all, because the
recording saw neither, so a mapping would be a guess.

## Not observed

- No Event name carried a `claude_code.` prefix.
- The OTLP log record field `eventName` was never populated.
- No Event named `tool_call` was seen. The observed tool Events are
  `tool_decision` and `tool_result`.
- No `api_error` Event was seen, because the Session succeeded.
- No `mcp_server_call` Event was seen. The only MCP Event observed was
  `mcp_server_connection`.
- No `run_start` or `run_end` Event was seen: those come from the Runner,
  not from the Agent.
- No `stop_reason` attribute was seen on any Event.
- No Transcript file was read for this document.
- `codex` and `gemini` emit nothing here, because neither is installed.
- `SPEC.md:252-255` writes the Claude Code event names with a
  `claude_code.` prefix, for example `claude_code.api_request`. The
  recording shows the record attribute `event.name` holds the bare
  name, for example `api_request`. The Normaliser matches the bare
  name, because `tickets.yaml:370-371` says the observed facts win
  over every example in SPEC.md. The OTLP log record `body` does
  carry the prefixed name, but no code reads the body.
- No MCP tool call was seen, so no recording exercises the `mcp`
  branch of the `tool_type` derivation; the only Fixture tool call
  is `Bash`, which is native. The second test in
  `test/normaliser.integration.test.ts` proves that branch instead,
  with an envelope built in code because no recording holds one.

A second recording, under a Task that uses an MCP server, is what would
fill these gaps.

## Verified Claude Code flags (2.1.270)

The primary session ran `claude --version` and `claude --help` on
2026-11-08, and the output below is verbatim. These flags are read from
the installed command-line interface, not copied from SPEC.md.

```
2.1.270 (Claude Code)
```

### Flags the Adapter uses

Every flag SPEC.md line 468 names exists on 2.1.270, so no flag in
SPEC.md needs correction.

```
  -p, --print                           Print response and exit (useful for
                                        pipes). Note: The workspace trust dialog
                                        is skipped when Claude is run in
                                        non-interactive mode (via -p, or when
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  --mcp-config <configs...>             Load MCP servers from JSON files or
                                        strings (space-separated)
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --dangerously-skip-permissions        Bypass all permission checks.
                                        Recommended only for sandboxes with no
                                        internet access.
```

The resulting launch vector:
`claude -p "<prompt>" --output-format json --mcp-config <file> --strict-mcp-config --dangerously-skip-permissions`

### Near-miss flags the Adapter must not use

```
  --allow-dangerously-skip-permissions  Enable bypassing all permission checks
                                        as an option, without it being enabled
                                        by default. Recommended only for
                                        sandboxes with no internet access.
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
```

- `--allow-dangerously-skip-permissions` only offers the bypass as an option. It does not apply the bypass.
- `--permission-mode bypassPermissions` is a documented alternative that reaches the same state, but SPEC.md line 468 names `--dangerously-skip-permissions`, so the Adapter uses that one.

### The --mcp-config file shape

`claude --help` documents only "Load MCP servers from JSON files or
strings (space-separated)" and does not document the file shape. The
shape below is read from a working Claude Code MCP configuration file on
the development machine, and it must be re-verified against the
installed version before it is trusted.

```json
{
  "mcpServers": {
    "<server name>": {
      "type": "stdio",
      "command": "uvx",
      "args": ["awslabs.core-mcp-server@latest"],
      "env": { "FASTMCP_LOG_LEVEL": "ERROR" }
    }
  }
}
```

End-to-end proof needs a real Run, which only `pnpm bench` performs,
and `bench` costs money, so no session has proved the shape yet.

### Open questions

- Whether `-p` and `--dangerously-skip-permissions` combine correctly is unproved. Both flags exist on 2.1.270. Proving the combination starts a paid session.
- Whether a `.` in a working directory path is encoded as `-` in the Transcript directory name is unverified. Hard prohibition 2 in CLAUDE.md forbids listing `~/.claude`, so no session has checked a path containing a dot.
- Whether the `--mcp-config` file accepts the `.mcp.json` shape is unproved, for the reason in the previous subsection.
</content>

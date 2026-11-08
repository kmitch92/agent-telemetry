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

## Counts survive without a keep-set entry

OTLP JSON encodes a 64-bit integer as a JSON string inside an `intValue`
wrapper. The redactor keeps a string found directly under `intValue`,
`doubleValue` or `boolValue` whatever its attribute key, so `input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`,
`cost_usd_micros`, `duration_ms`, `ttft_ms`, `prompt_length`,
`response_length`, `tool_input_size_bytes`, `tool_result_size_bytes`,
`total_duration_ms`, `num_hooks` and the other counts all survive
redaction without appearing in `KEEP_NAMES`.

## The Fixture

The Fixture is `test/fixtures/events/claude-code/01.jsonl`. It holds 7
lines, each an OTLP `resourceLogs` envelope, together carrying 39 log
records. Every line parses as JSON. It contains no absolute path, no email
address and no prompt text.

The Collector exports logs, metrics and traces to one file, per
`compose/collector/config.yaml:53-61`. The recording's appended window held
7 `resourceLogs` lines, 3 `resourceMetrics` lines and 0 `resourceSpans`
lines. Only the `resourceLogs` lines reached the Fixture.

The recording script wrote the Fixture once, under the keep-set as it
stood before the recording. That first pass blanked structural keys the
recording then showed were worth keeping, `tool_name` among them, so
`Bash` became a placeholder. After `KEEP_NAMES` was extended, the Fixture
was rebuilt by re-redacting the SAME captured lines out of the
Collector's sink. No second Agent Session was started, so the recording
cost one paid Session in total. The rebuild skipped the sink's first
line, which came from the operator script `scripts/send-test-event.ts`
and not from an Agent. After the rebuild the kept values are present:
`Bash` under `tool_name`, `probe` under `run_id`, `connected` under
`status`, `accept` under `decision`, `2.1.270` under `service.version`,
and `linux` under `os.type`.

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

## Every captured line is unknown_kind today

Running `classifyLine` over the Fixture gives 39 `unknown_kind` outcomes, 0
`event` outcomes and 0 `malformed` outcomes. The Collector's `transform`
processor is still an empty statement list, per
`compose/collector/config.yaml:16-18`, so no line carries a normalised Kind
yet. The `normaliser` ticket fills that processor. This is expected, rather
than a defect.

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

A second recording, under a Task that uses an MCP server, is what would
fill these gaps.
</content>

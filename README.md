# agent-telemetry

This repository is a local telemetry system for coding agents. It receives what an
Agent and its MCP (Model Context Protocol) servers emit outward on their own, folds
those Events into one row per Session, and shows four Grafana dashboards built from
files in this repository. It also runs fixed Tasks under named sets of MCP servers so
an operator can compare them. It is not a proxy, a wrapper, a hook, or a plugin: it
never sits in an Agent's request path, and the only influence it has on an Agent is an
environment variable and a per-Run configuration file under `runs/<run_id>/`. It is
single-user and local, with no cloud, no authentication, and no multi-tenancy. It never
exports prompt text, tool input, or tool output.

## Requirements

- Docker with `docker compose` that supports `--wait`.
- Node 22 or newer.
- pnpm 10.31.0.
- Claude Code on the `PATH`, for `pnpm bench` only.

## Quick start

Run these in order from the repository root.

```sh
pnpm install
pnpm compose:up
pnpm smoke
pnpm sessions
pnpm bench --task hello --agent claude-code --variant none --reps 1
pnpm report
```

`pnpm compose:up` starts the four services: the OpenTelemetry Collector, Loki,
Prometheus, and Grafana. It waits until every healthcheck passes. Grafana then opens at
`http://localhost:3000` with no login.

`pnpm smoke` replays the committed Transcript fixtures and the recorded Event fixtures
into the Collector, then runs every panel query on all four dashboards and fails if any
panel returns no data.

`pnpm sessions` folds `data/events.jsonl` into one row per Session and writes the
`sessions` table in `results.duckdb`. Add `--json` for machine-readable output. Filter
with `--agent <name>`, `--project <name>`, or `--since <iso|2h|30m|1d>`.

`pnpm bench` starts a real Claude Code session and costs money. It copies the Task
fixture, runs the Agent, runs the Checker, and writes one row per Run to the `runs`
table in `results.duckdb`. `--task` is required. The other flags default to
`--agent claude-code`, `--variant none`, `--cache cold`, and `--reps 1`. The two Tasks
in `tasks/` are `hello` and `hello-probe`.

`pnpm report` prints the Task by Variant table from the `runs` table. Add `--json` for
machine-readable output, or `--task <id>` to limit it to one Task.

To stop the services, run `pnpm compose:down`.

## What a Session is

A Session is the unit this system is built around. It is one continuous conversation
between a user and one Agent, keyed by the identifier that the Agent itself emits. A
Session exists whether or not this repository started it, so an ad hoc conversation in
a terminal is measured the same way as a Run that `pnpm bench` started.

Two concurrent Sessions stay separate because the key is the Agent's own session
identifier and never the working directory. Two conversations in the same project at
the same time therefore produce two Session rows, not one
(`src/sessions/index.ts:41`).

The idle boundary rule decides when a Session is finished. A Session stays open until
no Event carrying its session identifier arrives for 30 minutes, the value of
`SESSION_IDLE_MINUTES` (`src/sessions/index.ts:12`). Up
to that point the row reports `closed=false` and its summary may still change. After
that point the row reports `closed=true` and the summary is final. A late Event that
carries a closed Session's identifier reopens it, because the fold recomputes every row
from `data/events.jsonl` rather than mutating a stored row
(`src/sessions/index.ts:99`).

When an Agent emits no session identifier, the fold synthesises one from the Agent, the
project, and the process identifier, and marks the row `synthetic_session_id=true`.

## How to define a Variant

A Variant is a named set of MCP servers, and nothing more. Variants live in
`configs/variants.yaml` under the top-level `variants` key. Each Variant has one field,
`servers`. Each server entry has these fields:

| Field     | Type                    | Required | Default |
| --------- | ----------------------- | -------- | ------- |
| `name`    | string                  | yes      | none    |
| `command` | string                  | yes      | none    |
| `args`    | list of strings         | no       | `[]`    |
| `env`     | map of string to string | no       | `{}`    |

The schema that validates the file is
`src/schema/variant.ts`. It rejects any field not in the
table above.

A worked example. This adds a Variant named `single` that registers one stdio MCP
server started by a local script, with one environment variable:

```yaml
variants:
  single:
    servers:
      - name: lookup
        command: node
        args: ['./vendor/lookup-server/index.js']
        env:
          LOOKUP_DATA_DIR: './vendor/lookup-server/data'
```

Select it with `pnpm bench --task hello --variant single --reps 1`. Point at a different
Variant file with `--variants <path>`.

## How to point the system at an MCP server

Any MCP server may report its own internals by implementing the contract in
`docs/mcp-server-events.md`. The contract is optional and additive: everything in this
repository works without it. A server that implements it reads
`OTEL_EXPORTER_OTLP_ENDPOINT` once at startup and POSTs OTLP log records to
`<endpoint>/v1/logs`. When that variable is unset, the server sends nothing. Each record
names the event `mcp_server.call` and carries `mcp_server.call_id`, `mcp.method.name`,
`gen_ai.tool.name`, `mcp_server.total_ms`, and `mcp_server.status`. The full required and
optional attribute lists are in `docs/mcp-server-events.md`.

Check a server against the contract with the conformance checker. The Stack must be
running first, because the checker reads the Events that the server sends to the
Collector.

```sh
pnpm compose:up
pnpm mcp:conform -- <command that starts the server> [args...]
```

The checker starts the server over stdio, sets `OTEL_EXPORTER_OTLP_ENDPOINT` and
`OTEL_RESOURCE_ATTRIBUTES=run_id=conform-<ulid>` for it, drives a fixed sequence of
calls, waits for the Events to settle, and prints one line per check. It exits 0 when
every required check passes.

The Probe Server in this repository implements the contract and is the reference target:

```sh
pnpm mcp:conform -- tsx src/probe-server/cli.ts
```

Once a server passes, add it to a Variant in `configs/variants.yaml` as shown above, and
its `mcp_server.call` Events appear on the MCP Servers dashboard alongside the
`tool_call` Events that the Agent emits for the same tool.

## Adding an Agent

See `docs/adding-an-agent.md`. It describes the Adapter interface and was written from
the work of building the Claude Code Adapter.

## Known gaps

Each item below is an acceptance item in `SPEC.md` that does not pass from this tree, or
a dashboard panel that no real or replayed Event can fill. A panel in the second group is
deleted rather than fed with a fabricated Event, and the deletion is recorded here.

### `pnpm report` shows a zero median for `hello` under `none`

Command:

```sh
pnpm report
```

Output:

```
hello        none     3  0.6667     0             0                             26047           7610.0
```

The `runs` table holds three `hello` Runs under Variant `none`. The two earliest,
`01M6XAVPYAGBR9R9383WGMRJXH` and `01M6XB3S37C2Y3363ZFBDNG6MD`, recorded `turns=0` and
`input_tokens=0`, which drags the median to zero. The most recent,
`01M6XBRR7D3EWX8KEE9B2S5YTX`, recorded `turns=6`, `input_tokens=12`, and `pass=true`, so
the acceptance item itself is met by that Run. The stale rows are not deleted, because
deleting a Results row to improve a number is not permitted.

### Two acceptance items are unverified here

`SPEC.md:632` and `SPEC.md:638` require that the Runs dashboard and the MCP Servers
dashboard show panels filtered to one specific `run_id`. The Results rows, the `run_end`
Events, and the Session rows for both Runs exist, and `pnpm smoke` confirms that every
panel on all four dashboards returns data. The per-`run_id` filter itself was not
checked, because doing so needs a fresh `pnpm bench`, which starts a paid Agent session.

`docs/agent-events.md:48` records `codex` and `gemini` as not installed on this machine,
so no event name or attribute key is verified for either Agent.

### Deleted and incomplete panels

- `api_error` count by `error_type`, deleted from the Sessions dashboard. The
  Collector writes no `kind=api_error` mapping
  (`compose/collector/config.yaml:53`), and the Claude Code Transcript parser
  emits no such Event, so no replayed Event can feed the panel.
- Cost per Session, deleted from the Sessions dashboard, and the cost column is
  absent from the Sessions table. `pnpm replay --fixtures` never sets
  `cost_usd`, because the Claude Code Transcript holds no cost field
  (`src/replayer/parsers/claude-code.ts:58-67`). `pnpm replay --events` does
  carry `cost_usd`, so the gap is in the fixture path only.
- Session wall-time distribution reads `kind=run_end`. Only a replayed or
  benched Session carries a `run_end` Event, so a Session recorded live without
  the Runner leaves that panel empty.
- "Raw bytes against returned bytes, totals and ratio" on the MCP Servers
  dashboard reads NaN on its ratio series. The conformance script in
  `src/conform/script.ts` sends request text of the form
  `conform request <nonce>`, which matches no keyword in the Probe Server
  catalogue (`src/probe-server/catalogue.ts`), so every call routes to the
  catch-all target, makes no upstream request, and reports
  `mcp_server.raw_bytes` as zero, leaving that total zero and the
  ratio undefined. The panel stays, since both byte totals are real measured
  values; only the ratio awaits a Run with a routed call.

## Licence

This project is under the MIT License. See the `LICENSE` file for the full text.

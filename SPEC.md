# Agent Telemetry — Specification

## Purpose and scope

This repository is a local, zero-interference telemetry system. It measures coding-agent
sessions and lets an operator compare named sets of Model Context Protocol (MCP) servers on
fixed tasks. This document is the brief for an unattended build; every MUST below is tested by
the acceptance criteria.

**What it is**

- A docker compose Stack (Collector, Loki, Prometheus, Grafana) with datasources and four
  dashboards provisioned from the repository. After `docker compose up` and `pnpm smoke`, every
  panel shows data. Nothing is created by hand in the Grafana user interface.
- A Runner CLI that executes Task × Config × repetition, each in a fresh Fixture copy, writes
  one Results row per Run, and folds every Event into a Session index.
- A Replayer that turns Transcripts harvested from this machine, and raw Events recorded from
  live Agent sessions, into OTLP (OpenTelemetry Protocol) so the whole pipeline can be verified
  without running an agent.
- A Probe Server: a stub MCP server, built in this repository, that implements the MCP server
  event contract defined later in this document. It is a stand-in used to test the contract,
  the conformance checker, the Normaliser rules and the MCP Servers dashboard without needing
  any production MCP server installed.

**What it is not**

- It never modifies, wraps or proxies an Agent, and never sits in an Agent's request path. It
  only receives what Agents and MCP servers emit outward on their own.
- It is single-user and local: no cloud, no authentication, no multi-tenancy.

**Out of scope for v1:** traces and a trace-visualisation backend; live verification of an
Adapter for any Agent not installed on this machine; cost beyond what each Agent exports; any
change to an MCP server's own internals.

**MCP server event contract:** specified in full later in this document, under "MCP server
event contract", and committed as `docs/mcp-server-events.md` by a later build step. The
contract is optional and additive. Any MCP server may implement it to report its own internals,
and the whole system works fully without it, because the Probe Server already implements it.

## Glossary

These are the only terms used in this specification, its diagrams, the code and the dashboards.
Use them verbatim in identifiers and docs.

| Term | Meaning |
| --- | --- |
| Agent | A coding-agent CLI, for example Claude Code. Spawned by the Runner, or already running as an ad hoc session; never modified. |
| Session | One continuous conversation between a user and one Agent, identified by the identifier the Agent itself emits. A Session exists whether or not the Runner started it. Most Sessions on a developer machine are ad hoc. |
| Probe Server | A stub MCP server in this repository that implements the MCP server event contract. Used to test the pipeline without needing a production MCP server. |
| Variant | A named set of MCP servers, defined in `configs/variants.yaml`. Nothing more. |
| Stack | The docker compose services: Collector, Loki, Prometheus, Grafana. |
| Collector | OpenTelemetry Collector (contrib image). Receives OTLP on 4317 (gRPC) and 4318 (HTTP). |
| Event | One OTLP log record from an Agent, an MCP server, the Probe Server, or the Runner. |
| Normaliser | The Collector's transform stage. Stamps common attributes onto every Event. The only place Agent-specific event names are known. |
| Common schema | The Zod types every normalised Event must satisfy: `ModelCall`, `ToolCall`, `McpServerCall`, `RunSummary`, and the rest of the discriminated union. |
| Runner | The TypeScript CLI that executes Runs. |
| Run | One Task under one Config, one repetition. Keyed by `run_id` (a ULID, Universally Unique Lexicographically Sortable Identifier). One Run maps to one or more Sessions. |
| Task | A YAML file: prompt, Fixture, Checker, expected tools, timeout. |
| Config | Variant + cache state (`cold` or `warm`) + Agent. |
| Fixture | A project folder copied fresh for every Run. |
| Checker | A command the Runner executes in the Fixture copy after the Agent exits. Exit 0 means pass. |
| Adapter | Per-Agent module: launch command, MCP config file format, telemetry environment variables, Transcript locator. |
| Transcript | The session log an Agent writes on its own (Claude Code: JSONL under `~/.claude/projects`). |
| Replayer | Converts Transcripts or recorded Events into OTLP and sends them to the Collector. |
| Results | `results.duckdb`: one row per Run, written by the Runner, in table `runs`. |
| Session index | The component that folds `data/events.jsonl` into one row per Session, in `results.duckdb`, table `sessions`. |
| events.jsonl | The Collector's file-exporter output: every normalised Event, one JSON line each. |

## Architecture

```
  ┌──────────┐      spawn: the only arrow that points into an Agent
  │  Runner  │ ──────────────────────────────────────────────────┐
  └────┬─────┘                                                   ▼
       │                                                   ┌───────────┐
       │                                                   │   Agent   │
       │                                                   └──┬─────┬──┘
       │            tool calls (MCP protocol)                 │     │
       │       ┌──────────────────────────────────────────────┘     │
       │       ▼                                                    │
       │  ┌─────────────────────────────────────────┐               │
       │  │ MCP servers: any server, including the  │               │
       │  │ Probe Server that ships in this repo    │               │
       │  └──────────────────┬──────────────────────┘               │
       │ events              │ events                       events  │
       ▼                     ▼                                      ▼
  ┌────────────────────────────────────────────────────────────────────┐
  │                             Collector                              │
  └─────────┬────────────────────┬─────────────────────────┬───────────┘
            ▼                    ▼                         ▼
      ┌──────────┐        ┌──────────────┐      ┌─────────────────────┐
      │   Loki   │        │  Prometheus  │      │  data/events.jsonl  │
      └─────┬────┘        └──────┬───────┘      └──────────┬──────────┘
            └─────────┬──────────┘                         │ read
                      ▼                                    ▼
                ┌───────────┐                  ┌──────────────────────┐
                │  Grafana  │                  │ Session index        │
                └───────────┘                  │ Runner aggregation   │
                                               └──────────┬───────────┘
                                                          ▼ write
                                               ┌──────────────────────┐
                                               │ results.duckdb       │
                                               │ sessions · runs      │
                                               └──────────────────────┘
```

No arrow ever points back into the Agent box. The Runner, the Agent and the MCP servers all
emit outward, one way, into the Collector. The Collector fans out to Loki,
Prometheus and `data/events.jsonl`. Grafana reads only Loki and Prometheus. The Session index and
the Runner read `data/events.jsonl` from the host filesystem and write `results.duckdb`. The
Runner also sends `run_start` and `run_end` straight to the Collector (not drawn as a separate
path, since it is the same outward-only emission as any other component).

## Repo layout

One package, no monorepo: pnpm, TypeScript strict, Zod, vitest, tsx for scripts.

```
agent-telemetry/
├─ README.md                      quick start: compose up, smoke, bench, report, sessions
├─ SPEC.md                        this document, exported
├─ docs/
│  ├─ mcp-server-events.md        MCP server event contract (exported from this document)
│  ├─ agent-events.md             per-Agent event catalogue as observed on this machine
│  └─ adding-an-agent.md          every step and fact needed to add a second Agent
├─ compose/
│  ├─ docker-compose.yml
│  ├─ collector/config.yaml       receivers, Normaliser (transform), exporters
│  ├─ loki/config.yaml
│  ├─ prometheus/prometheus.yml
│  └─ grafana/
│     ├─ provisioning/datasources/datasources.yaml
│     ├─ provisioning/dashboards/dashboards.yaml
│     └─ dashboards/{sessions,tool-calls,mcp-servers,runs}.json   generated, committed
├─ src/
│  ├─ schema/                     Zod: Task, Config, Event kinds, RunSummary, Results row
│  ├─ events/                     OTLP log sender (fire-and-forget), events.jsonl reader
│  ├─ sessions/                   pure fold of Events into Session rows, thin DuckDB writer
│  ├─ adapters/                   claude-code.ts, index.ts
│  ├─ runner/                     cli, lifecycle, fixture copy, checker, results (DuckDB)
│  ├─ replayer/                   transcript parsers per Agent, cli
│  ├─ probe-server/               stdio MCP server, one tool, emits the MCP server event contract
│  ├─ conform/                    conformance check for an MCP server (see docs/mcp-server-events.md)
│  ├─ dashboards/                 generators that write compose/grafana/dashboards/*.json
│  └─ report/                     Task × Variant table from Results
├─ tasks/                         Task YAML files (hello.yaml, zod-docs.yaml, …)
├─ fixtures/                      Fixture folders referenced by tasks/
├─ configs/variants.yaml          MCP server definitions per Variant
├─ test/
│  ├─ fixtures/transcripts/       redacted Transcripts harvested from this machine
│  ├─ fixtures/events/            redacted raw Events recorded from live Agent sessions
│  └─ *.test.ts
├─ scripts/
│  ├─ harvest-transcripts.ts
│  ├─ record-live.ts
│  └─ smoke.ts
├─ data/                          bind-mounted into the Collector: events.jsonl (gitignored)
└─ runs/                          per-Run work dirs and logs (gitignored)
```

`package.json` scripts: `compose:up`, `compose:down`, `smoke`, `replay`, `record`, `harvest`,
`bench`, `report`, `sessions`, `mcp:conform`, `dashboards:build`, `verify`, `test`, `typecheck`,
`lint`.

## Engineering standards

The build must satisfy every item below.

- pnpm as the package manager. Node 22 (22.18.0 verified on this machine; `node --version`
  reported it). pnpm 10.31.0 installed. TypeScript strict mode, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax` and
  `isolatedModules`.
- Schema-first: every external shape has a Zod schema, and the TypeScript type is derived from
  it with `z.infer`. A type is never written twice.
- Functional core, imperative shell: parsing, normalising, folding and aggregating are pure
  functions, with no file, network or database access. Process spawn, file system, HTTP and
  DuckDB access live only in thin edge modules.
- Test-driven for parsers, the redactor, the Session fold, the aggregation and the report query:
  the failing test is written first, and committed in the same change as the code that makes it
  pass.
- vitest with coverage thresholds: 90 percent of lines and 85 percent of branches on
  `src/schema`, `src/events`, `src/sessions` and `src/replayer/parsers`.
- eslint flat configuration with typescript-eslint `strictTypeChecked`, plus prettier. One
  `pnpm verify` script that runs typecheck, lint and test.
- Exact dependency versions, no caret or tilde ranges. Pinned Docker image tags. A committed
  lockfile.
- A git pre-commit check that runs typecheck and lint on staged files only.
- A continuous integration workflow that runs `pnpm verify` and the Normaliser integration test
  against a real collector in compose.
- Conventional commit messages, one logical change per commit.
- No secret, no absolute home-directory path and no unredacted capture is ever committed.

## Stack

`docker compose up -d --wait` from `compose/` MUST return only when all four services are
healthy. Pin every image tag.

| Service | Image | Port | Requirements |
| --- | --- | --- | --- |
| Collector | otel/opentelemetry-collector-contrib | 4317, 4318 | Receivers: `otlp` gRPC + HTTP. Processors: `memory_limiter`, `transform` (the Normaliser, next section), `batch`. Exporters: `otlphttp/loki` to Loki's native OTLP endpoint; `otlphttp/prometheus` to Prometheus's OTLP receiver; `file` to `/data/events.jsonl` with rotation; `debug` at sampled verbosity for development. Pipelines: logs → transform → loki + file; metrics → prometheus + file; traces → file only. |
| Loki | grafana/loki 3.x | 3100 | Native OTLP ingest. `allow_structured_metadata: true`. Resource attributes promoted to index labels: `service.name`, `agent`, `session_id`, `project`, `run_id`, `task`, `variant`. Everything else stays structured metadata and is filtered in LogQL (Loki Query Language). Single-node filesystem storage, 30-day retention. |
| Prometheus | prom/prometheus 3.x | 9090 | OTLP receiver enabled. `otlp.promote_resource_attributes`: `service.name`, `agent`, `session_id`, `project`, `run_id`, `task`, `variant`. Out-of-order window 30 minutes. |
| Grafana | grafana/grafana 11.x | 3000 | Anonymous access on, with org role Admin (no login). Datasources provisioned with fixed unique identifiers `loki` and `prometheus`. Dashboards provisioned from `/var/lib/grafana/dashboards` into folder "Agent Telemetry", `allowUiUpdates: false`. Home dashboard is Sessions. |

Volumes: named volumes for Loki, Prometheus and Grafana state; `./data` bind-mounted into the
Collector so the Runner on the host reads `events.jsonl` directly. Healthchecks on all four
services.

`session_id` is the highest-cardinality promoted label. On a developer machine, a few hundred
Sessions is well within what a single-node Loki handles comfortably. Label cardinality in
general is fine locally: a few streams per Run, hundreds of Runs and Sessions.

Note that OTLP attribute names become Loki labels with dots replaced by underscores
(`service.name` becomes `service_name`); verify the actual label names after the first ingest and
use the verified names in the dashboards.

## Normaliser and common schema

The Collector's `transform` processor stamps one common attribute set onto every Event.
Dashboards and the Runner read only those attributes, so one dashboard serves every Agent.
Agent-specific event names exist in exactly one file: `compose/collector/config.yaml`.

**Resource attributes**, in order of importance, carried by every Event:

1. `agent` — derived in the Normaliser from `service.name`. Values seen so far: `claude-code`.
2. `session_id` — the Agent's own session identifier (see "Session identity", next section).
3. `project` — a stable short identifier for the working directory, written as
   `<basename>-<first 8 hex of sha256 of the absolute path>`.
4. `run_id`, `task`, `variant`, `config` — present only when the Runner started the Session.
   Absent for ad hoc Sessions. Nothing in this specification may require them.

**Common record attributes**

| kind | Attributes |
| --- | --- |
| `model_call` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `duration_ms`, `cost_usd` (Claude Code only), `session_id`, `agent`, `project` |
| `tool_call` | `tool`, `duration_ms`, `success` (bool), `tool_type` (`mcp` or `native`), `result_bytes` (where the Agent exposes it), `mcp_server` (string, unset for native tools), `session_id`, `agent`, `project` |
| `prompt` | `prompt_length`, `session_id`, `agent`, `project` (prompt text never captured) |
| `api_error` | `model`, `status_code`, `error_type`, `attempt`, `session_id`, `agent`, `project` |
| `mcp_server_call` | the `mcp_server.*` attributes from `docs/mcp-server-events.md`, passed through unchanged, plus `session_id`, `agent`, `project` |
| `run_start` / `run_end` | `task`, `config`, `variant`, `agent`, `rep`, `session_id`, `project`, and on `run_end`: `pass`, `exit_code`, `timed_out`, `wall_ms`, `turns`, `tool_calls`, `mcp_server_calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `expected_tools_hit` |

`mcp_server` is derived: a `tool` named `mcp__<server>__<tool>` sets `mcp_server` to `<server>`
and `tool_type` to `mcp`; any other tool sets `tool_type` to `native` and leaves `mcp_server`
unset.

**Mapping for Claude Code** (starting point; the agent building this repository MUST correct it
against recorded Events and record the verified version in `docs/agent-events.md`)

| Agent | Source event | kind | Field mapping |
| --- | --- | --- | --- |
| Claude Code | `claude_code.api_request` | `model_call` | `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` → `cache_write_tokens`, `duration_ms`, `cost_usd`; `session.id` → `session_id` (this source attribute MUST be verified against a live recording and corrected if wrong) |
| Claude Code | `claude_code.tool_result` | `tool_call` | `tool_name` → `tool`, `success`, `duration_ms` |
| Claude Code | `claude_code.user_prompt` | `prompt` | `prompt_length` |
| Claude Code | `claude_code.api_error` | `api_error` | `model`, `status_code`, `error`, `attempt` |
| Any MCP server implementing the contract, including the Probe Server | `mcp_server.call` | `mcp_server_call` | passthrough, per "MCP server event contract" |
| Runner | `runner.run_start`, `runner.run_end` | `run_start`, `run_end` | passthrough |

Rules: match on wherever the recorded Events carry the event name (the `event.name` attribute or
the log record's event-name field; check the recording). A field the Agent does not expose stays
unset, never fabricated. Unknown event names pass through with `kind` unset and are counted by
the `events.jsonl` reader, per Agent.

**Zod** (`src/schema/events.ts`): one discriminated union on `kind`, with members `model_call`,
`tool_call`, `prompt`, `api_error`, `mcp_server_call`, `run_start`, `run_end`; one schema per
kind, with the resource attributes merged in, and `session_id`, `agent` and `project` present on
every kind. The `events.jsonl` reader validates every line and reports the count of unknown kinds
per Agent. Integration test: the raw Event fixtures are sent through a real Collector (compose)
and every output line must parse, with zero unknown kinds for Claude Code.

## Session identity

A Session is the primary dimension of this specification. Every dashboard, the Session index and
the Runner's own bookkeeping key on the Session, not on the Run.

- **Source of the identifier.** `session_id` comes from the Agent's own event attribute. For
  Claude Code, the starting point recorded here is `session.id`; this MUST be verified against a
  live recording and corrected in `docs/agent-events.md` if the real attribute differs.
- **Separation rule.** Two Sessions of the same Agent, in the same project, at the same time,
  MUST stay separate. The key is the Agent's own identifier, never the directory, so two
  concurrent conversations in one project never merge.
- **Session boundary rule.** A Session stays open until no Event carrying its `session_id`
  arrives for `SESSION_IDLE_MINUTES`, default 30 minutes. At that point it is closed and its
  summary is final. A late Event carrying a closed Session's `session_id` reopens it, and the
  summary is recomputed.
- **Fallback.** When an Agent emits no session identifier at all, the Session index synthesises
  one from `agent`, `project` and the process identifier, and marks the Session
  `synthetic_session_id=true` so dashboards can show the degradation honestly. The Session index
  never fabricates an identifier that looks like a real one.
- **Relationship to Runs.** The Runner's `run_id` is a label on a Session, never its key. One Run
  maps to one or more Sessions; a Run that drives several Agent conversations, or that is retried
  inside the same Run directory, still produces one Session per distinct `session_id`.

**Session index** (`src/sessions/`)

- Reads `data/events.jsonl` and upserts one row per Session into `results.duckdb`, table
  `sessions`.
- Columns: `session_id`, `agent`, `project`, `project_path` (absolute path, local file only,
  never exported), `started_at`, `last_event_at`, `closed`, `synthetic_session_id`,
  `model_calls`, `tool_calls`, `mcp_server_calls`, `prompts`, `api_errors`, `input_tokens`,
  `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`, `cost_usd`,
  `wall_ms`, `run_id` (nullable), `task` (nullable), `variant` (nullable).
- `pnpm sessions` prints the table, newest first, with `--agent`, `--project`, `--since` and
  `--json` filters.
- It is a pure fold over Events plus a thin DuckDB write at the edge: the fold itself takes an
  iterable of parsed Events and returns Session rows, with no file or database access inside it.

## Dashboards

Four dashboards are provisioned from JSON in the repository, and MUST show data on every panel
within 60 seconds of `pnpm smoke`. All panels query the common attributes, never Agent-native
names. Dashboard JSON is generated by `src/dashboards/` and committed; nothing is edited in the
Grafana user interface. The home dashboard is Sessions.

Template variables on every dashboard, all multi-select, all populated from Loki label values:
`agent`, `project`, `session_id`, `variant`, `task`, `run_id`, plus the time range. Every panel
carries a description naming what it shows and which `kind` it reads.

**Sessions (home)**

- Table of Sessions, newest first: session identifier, agent, project, start, last event, open
  or closed, model calls, tool calls, input tokens, cost, run identifier.
- Sessions started over time, by agent.
- Model calls over time, by Session.
- Input tokens per model call, as a time series per Session (shows context growth).
- Output tokens per call.
- Cache-read share of input tokens.
- Model call latency, p50 and p95, by agent.
- `api_error` count by `error_type`.
- Cost per Session, labelled as available for Claude Code only.
- Prompts per Session.
- Session wall-time distribution.

**Tool calls**

- Calls per `tool` (bar, top 20).
- Success rate per `tool`.
- Duration p50 and p95 per `tool`.
- Calls by `tool_type` (mcp against native), over time.
- Calls per `mcp_server`.
- `result_bytes` per `tool`, where present.
- Tool calls per Session.

**MCP Servers**

- `mcp_server_call` rate, per server.
- `mcp_server.total_ms`, `mcp_server.internal_ms` and `mcp_server.upstream_ms`, p50 and p95, per
  server.
- Cache hit ratio per server.
- Target distribution, top 10.
- Raw bytes against returned bytes, totals and ratio.
- Errors by `mcp_server.error.type`.
- Calls per Session.

**Runs**

- Pass rate by variant (stat).
- Pass rate per task and variant (table).
- Turns per Run, by variant.
- Wall time per Run, by variant.
- Input tokens per Run, by variant.
- Tool calls per Run, by variant.
- Timed-out Runs.
- Table of `run_end` Events, newest first: `run_id`, task, variant, agent, pass, turns, input
  tokens, wall time.

**Query intent** (LogQL; label names to be confirmed after first ingest)

- Calls per tool:
  `sum by (tool) (count_over_time({agent=~"$agent"} | kind="tool_call" [$__range]))`
- p95 tool duration:
  `quantile_over_time(0.95, {agent=~"$agent"} | kind="tool_call" | unwrap duration_ms [$__interval]) by (tool)`
- Pass rate by variant:
  `sum by (variant) (count_over_time({service_name="runner"} | kind="run_end" | pass="true" [$__range])) / sum by (variant) (count_over_time({service_name="runner"} | kind="run_end" [$__range]))`
- Input tokens per model call:
  `{run_id=~"$run_id"} | kind="model_call" | unwrap input_tokens` as a time series.
- Sessions table freshness check:
  `count_over_time({agent=~"$agent"} [$__range]) by (session_id)` confirms that every
  `session_id` shown in the Sessions table also has Events in Loki for the selected range.

**Enforcement:** `scripts/smoke.ts` reads every dashboard JSON, runs each panel's query against
the Loki or Prometheus HTTP API over the last hour, and fails if any query returns no series.
This is what makes "no manual metric creation" a tested property rather than an intention.

## Runner

`pnpm bench --task <id> --agent <name> --variant <name> --cache <cold|warm> --reps <n>`
executes every combination, each in a fresh Fixture copy, and writes one Results row and one
`run_end` Event per Run.

**Task** (`tasks/<id>.yaml`, Zod-validated)

```yaml
id: zod-work-email
prompt: "Add a refinement so email must be a work address. Check the Zod docs."
fixture: fixtures/zod-app
checker: npm test
expected_tools: [context7.query-docs]
timeout_s: 600
tags: [docs-lookup]
```

**Variants** (`configs/variants.yaml`): per Variant, the MCP servers to register for the Agent
(name, command, args, env). There are no built-in Variant names except `none`, which registers no
MCP servers; a user defines every other Variant. The repository ships one example Variant,
`probe`, which registers the Probe Server under server name `probe`, purely so that
`pnpm bench` and `pnpm mcp:conform` have something concrete to run against in a clean clone; a
user may rename it, extend it or delete it.

**Run lifecycle**

1. Mint `run_id` (a ULID). Create `runs/<run_id>/`. Copy the Fixture to `runs/<run_id>/work` and
   `git init` it so the Checker can diff.
2. Write the Agent's MCP config for the Variant into the Run directory, in the format the
   Adapter specifies.
3. Cache state: `cold` starts every MCP server in the Variant fresh for this Run; `warm` performs
   one unrecorded priming Run of the same Task first, and keeps those server processes alive.
4. Send `runner.run_start` to the Collector with resource attributes `run_id`, `task`, `variant`,
   `config`, `agent`.
5. Spawn the Agent through the Adapter: `cwd` is the work directory; environment is the
   Adapter's telemetry variables pointed at `http://localhost:4318`,
   `OTEL_RESOURCE_ATTRIBUTES=run_id=…,task=…,variant=…,config=…`, export intervals of 1 second.
   Standard output and standard error go to `runs/<run_id>/agent.log`.
6. Wait for exit or `timeout_s`. On timeout: SIGTERM, then SIGKILL after 10 seconds; mark
   `timed_out`.
7. Run the Checker in the work directory. Record exit code and output.
8. Settle: poll `events.jsonl` for this `run_id` until no new line arrives for 5 seconds, 30
   seconds maximum.
9. Aggregate from `events.jsonl` filtered by `run_id`: `turns` is the count of `model_call`;
   token sums; `tool_calls`; `mcp_server_calls`; `expected_tools_hit` is true when the first
   `tool_call`'s tool is in the Task's `expected_tools`; `cache_hits`.
10. Send `runner.run_end` with the aggregates and the Checker result. Append the Results row.

**Results row** (`results.duckdb`, table `runs`): `run_id`, `started_at`, `task`, `agent`,
`variant`, `cache`, `rep`, `pass`, `exit_code`, `timed_out`, `wall_ms`, `turns`, `tool_calls`,
`mcp_server_calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
`input_tokens_per_turn`, `cost_usd`, `expected_tools_hit`, `cache_hits`, `checker_output`. A Run
may drive more than one Session; query the `sessions` table, filtered by `run_id`, to find all of
them.

**Report:** `pnpm report [--task <id>]` prints per Task × Variant: n, pass rate, median turns,
median input tokens per turn, median wall time, p95 tool duration. One DuckDB query in
`src/report/`.

**Isolation rules:** never resume a session; never touch `~/.claude`, `~/.codex` or `~/.gemini`;
per-Run configuration lives under `runs/<run_id>/`; the Agent is started with only the Variant's
MCP servers (Claude Code: `--strict-mcp-config`), so globally configured servers do not leak
into Runs.

## Agent adapters

An Adapter is the only Agent-specific code in the Runner. It has four members and nothing else:

```ts
type Adapter = {
  name: string; // e.g. 'claude-code'; see docs/adding-an-agent.md to add another
  launch(p: { prompt: string; cwd: string; env: Env; mcpServers: McpServer[] }): ChildProcess;
  telemetryEnv(p: { endpoint: string; resource: Record<string, string> }): Env;
  transcriptPaths(p: { cwd: string; since: Date }): Promise<string[]>;
};
```

**Claude Code Adapter**, specified end to end, since Claude Code is the only Agent verified on
this machine (version 2.1.270 installed):

| | Claude Code |
| --- | --- |
| Headless launch | `claude -p "<prompt>" --output-format json --mcp-config <file> --strict-mcp-config --dangerously-skip-permissions` |
| Telemetry switch | `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, `OTEL_METRIC_EXPORT_INTERVAL=1000`, `OTEL_LOGS_EXPORT_INTERVAL=1000` |
| `run_id` stamping | `OTEL_RESOURCE_ATTRIBUTES` (verify it is honoured against a live recording) |
| Transcript | `~/.claude/projects/<encoded cwd>/<session>.jsonl` |
| Status | MUST work end to end; it is installed on this machine. |

Flags and environment variable names above are the starting point. Before relying on any of
them, run the installed CLI with `--help` and correct the Adapter; record the verified flags and
versions in `docs/agent-events.md`.

**Fallback when `OTEL_RESOURCE_ATTRIBUTES` is not honoured:** the Runner records the Run's start
and end times and finds the Agent's `session_id` as the first one whose Events fall inside that
window. It backfills `run_id` in the aggregates and in Results; dashboards for that Agent group
by `session_id` instead. Document which path the Agent takes.

Prompt text is never exported: `OTEL_LOG_USER_PROMPTS` stays unset for Claude Code, and the
equivalent switch for any future Agent stays off by default.

**`docs/adding-an-agent.md`** is a required deliverable: a written guide that states every step
and every fact a contributor must verify before a second Agent can be added. It MUST cover at
least:

- How to confirm the Agent is installed and which version, by running its own `--version` flag.
- How to find the Agent's headless or non-interactive launch flags, by running its own `--help`
  flag, never by assuming flags from another Agent.
- How to find or enable the Agent's OpenTelemetry export switches, and how to point them at
  `http://localhost:4318`.
- How to confirm whether `OTEL_RESOURCE_ATTRIBUTES` is honoured, by running `record-live` once
  with a known `run_id` and inspecting the recorded Events.
- How to locate the Agent's own session identifier attribute, and how to record it in
  `docs/agent-events.md`.
- How to locate the Agent's Transcript files on disk, for the Replayer's harvest step.
- How to confirm the Agent never logs prompt text by default, and how to keep it that way.
- The requirement to add one row to the Adapter's internal registry, one parser in
  `src/replayer/parsers/`, and one section in `docs/agent-events.md`, each backed by a passing
  test against a real recording, before the Agent is considered supported.

## Agents not yet supported

Codex CLI and Gemini CLI are not installed on this development machine: running
`codex --version` and `gemini --version` both report command not found. This specification makes
no claim about their event names, attribute keys, launch flags or telemetry switches, because no
live recording exists to verify any of it. Adding support for either of them, or for any other
Agent, follows the steps in `docs/adding-an-agent.md`. Until that guide is followed and a live
recording is captured and committed, no Adapter, mapping table row or dashboard panel may
reference them.

## MCP server event contract

This contract is owned by this repository and specified here, not borrowed from any external
document. It is committed as `docs/mcp-server-events.md` by a later build step. It is optional
and additive: any MCP server may implement it to report its own internals, and the system works
fully without it, because the Probe Server already implements it in full.

**Primary event**, name `mcp_server.call`, set in both the log record's event-name field and an
`event.name` attribute. One per `tools/call`.

**MUST attributes:** `mcp_server.call_id` (string, a ULID), `mcp.method.name` (string),
`gen_ai.tool.name` (string), `mcp_server.total_ms` (int), `mcp_server.status` (enum `ok`,
`error`), and `mcp_server.error.type` when status is `error` (closed enum `no_target`,
`upstream_http`, `upstream_timeout`, `upstream_connect`, `bad_request`, `internal`).

**SHOULD attributes:** `mcp_server.internal_ms` (int, time spent in the server's own logic),
`mcp_server.upstream_ms` (int, MUST when an upstream request was made),
`mcp_server.upstream.service` (string), `mcp_server.upstream.status` (int),
`mcp_server.upstream.attempts` (int), `mcp_server.target` (string, `<service>.<operation>`, for
servers that route), `mcp_server.route.confidence` (number, 0 to 1), `mcp_server.cache` (enum
`hit`, `miss`, `bypass`, `stale`), `mcp_server.raw_bytes` (int), `mcp_server.returned_bytes`
(int), `mcp_server.request_bytes` (int), `mcp_server.error.message` (string, 256 characters
maximum), `mcp.tool.is_error` (bool), `mcp.request.id` (string), `mcp.session.id` (string),
`mcp.client.name` and `mcp.client.version` (string), `service.version` (string).

**Resource:** `service.name` is the server's own name, not a constant.
`OTEL_RESOURCE_ATTRIBUTES` is parsed for `run_id`, `task`, `variant` and `config` when present.

**Secondary events**, all SHOULD: `mcp_server.start`, `mcp_server.upstream.error`,
`mcp_server.cache.evict`, `mcp_server.cache.flush`.

**Transport MUST:** OTLP over HTTP, log signal, POST to `<endpoint>/v1/logs`, endpoint read from
`OTEL_EXPORTER_OTLP_ENDPOINT`; unset means telemetry off with zero network calls. A batch log
record processor with a 1 second scheduled delay and a 2 second export timeout. Flush on
SIGTERM, SIGINT and standard-input close, capped at 2 seconds. Build the Event during the call,
but hand it to the processor only after the response is written. Never await an export inside
the call path. Never throw. On an unreachable collector, write one line to standard error at the
first failure, then stay silent. No attribute value over 2 kilobytes. No attribute may contain
request or response text.

**Conformance check**, `pnpm mcp:conform -- <command that starts the server>`:

1. Start the server over stdio with `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and
   `OTEL_RESOURCE_ATTRIBUTES=run_id=conform-<ulid>`.
2. Drive a fixed script: `initialize`, six distinct `tools/call` requests, the same six again
   (expecting cache hits where the server caches), one deliberately invalid request, then close
   standard input.
3. Wait for the settle rule: no new `data/events.jsonl` line for 5 seconds, 30 seconds maximum.
4. Assert exactly thirteen `mcp_server.call` Events, each with a unique `mcp_server.call_id`;
   every MUST attribute present with the right type and enum membership; the invalid request
   produced `status=error` with a closed-set `error.type`; no attribute value over 2 kilobytes;
   no attribute containing the request text sent; `run_id` present on every Event. Warn, do not
   fail, on missing SHOULD attributes and on a missing `mcp_server.start`.
5. Exit non-zero on any MUST failure.

**Probe Server** (`src/probe-server/`): a stdio MCP server built on `@modelcontextprotocol/sdk`
that implements this contract by construction. It exposes one tool, `probe`, with input
`{ request: string }`, picks a target from a fixed in-repository catalogue by keyword, sleeps 50
to 400 milliseconds, caches by request hash, returns a canned result, and emits one
`mcp_server.call` Event per call carrying every MUST and SHOULD attribute. It exists so the
contract, the conformance checker, the Normaliser rules and the MCP Servers dashboard are all
testable without any external server.

## Replayer and test beds

Real Transcripts from this machine are the test beds. The Replayer turns them into Events, so
every dashboard and every Normaliser rule is verified without running an agent.

**Harvest** (`scripts/harvest-transcripts.ts`): scan `~/.claude/projects/**/*.jsonl`, and any
other Agent's Transcript locations, if an Adapter for that Agent is present. Select the 20 most
recent sessions with at least 5 tool calls. Redact, then write to
`test/fixtures/transcripts/<agent>/<hash>.jsonl`.

**Redaction:** replace every message text, tool input, tool output and file path with a
length-preserving placeholder. Keep timestamps, roles, usage counts, tool names including their
`mcp__` prefixes, stop reasons, `tool_use_id` links and a hashed session identifier. A redactor
test samples strings from each source file and asserts none appears in the output. Unredacted
material is never committed.

**Transcript parsers** (`src/replayer/parsers/<agent>.ts`), Claude Code first:

- user message → `prompt`
- assistant message with `usage` → `model_call` (tokens from `usage`; `duration_ms` is the gap
  from the previous message's timestamp)
- `tool_use` block plus its `tool_result`, matched by `tool_use_id` → `tool_call`
  (`duration_ms` is the result timestamp minus the use timestamp; `result_bytes` is the length of
  the result content; `success` is `not is_error`)

**Record live** (`scripts/record-live.ts`): run `claude -p "List the files in this directory,
then stop."` with telemetry pointed at the Collector, wait for the settle rule, then copy this
session's raw lines from `events.jsonl` into `test/fixtures/events/claude-code/<n>.jsonl` through
the same redactor. Repeat for any other Agent found installed on the machine. These recordings
are the ground truth for event names and attribute keys; `docs/agent-events.md` is written from
them.

**OTLP sender** (`src/events/otlp.ts`): builds OTLP/HTTP JSON log records and posts them to
`/v1/logs`. Shared by the Replayer, the Runner and the Probe Server. Fire-and-forget: 2 second
timeout, never throws, never blocks the caller.

**Replay modes:** `pnpm replay --fixtures` sends every Transcript fixture as Events, with a
synthetic `run_id` per Transcript and a synthetic `run_end`, so the Runs dashboard populates.
`pnpm replay --events` re-sends the recorded raw Events unchanged, which exercises the Normaliser
exactly as a live Agent would.

**Smoke** (`scripts/smoke.ts`): `compose up --wait` → `replay --fixtures` → `replay --events` →
run every dashboard panel query → fail on any empty result → print `http://localhost:3000`.

## Acceptance criteria

The build is done when every item below passes from a clean clone, in this order.

- [ ] `docker compose up -d --wait` in `compose/` succeeds; Grafana at `http://localhost:3000`
      opens without login; both datasources report healthy.
- [ ] `pnpm smoke` passes: every panel on all four dashboards returns data within 60 seconds.
- [ ] `pnpm test` passes: schema tests, redactor test, Claude Code Transcript parser tests
      against the fixtures, Session fold tests, Normaliser integration test (raw Event fixtures
      through a real Collector; every output line parses; zero unknown kinds for Claude Code).
- [ ] `pnpm bench --task hello --agent claude-code --variant none --reps 1` runs a real Claude
      Code session on this machine, passes its Checker, and yields a Results row, a `run_end`
      Event, and Runs-dashboard panels filtered to that `run_id` with `turns > 0` and
      `input_tokens > 0`.
- [ ] `pnpm sessions --json` lists at least one Session row for that same session, with
      `model_calls > 0` and `closed=false` until the idle window elapses.
- [ ] `pnpm bench --task hello --agent claude-code --variant probe --reps 1` does the same
      through the Probe Server; the MCP Servers dashboard shows at least one `mcp_server_call`
      with that `run_id`; the `tool_call` Events for the probe tool carry `mcp_server=probe` and
      `tool_type=mcp`.
- [ ] `pnpm report` prints the Task × Variant table from Results, and `pnpm mcp:conform` passes
      against the Probe Server.
- [ ] `docs/agent-events.md` lists, per Agent, the event names and attribute keys actually
      observed, with "unverified" wherever no live recording exists.
- [ ] No unredacted Transcript or Event fixture is committed; the redactor test enforces it.
- [ ] README quick start works in the order: compose up, smoke, bench, sessions, report.

Never make a panel pass by feeding it fabricated data. A panel that cannot be fed from real or
replayed Events is removed and listed under Known gaps in the README.

## Build order

Work in this order, and commit after each step with a one-line message naming it. If a step
cannot be finished, write the failing command and error under Known gaps in the README and move
on.

1. Scaffold: pnpm, Node 22, strict tsconfig, vitest, Zod, eslint flat configuration, scripts
   stubbed. Commit.
2. Stack: compose with all four services, healthchecks, datasource provisioning, four empty
   dashboards (`sessions`, `tool-calls`, `mcp-servers`, `runs`). `compose up --wait` green.
3. OTLP sender, common schema, `events.jsonl` reader, unit tests.
4. Session index (`src/sessions/`): the pure fold into Session rows, the thin DuckDB writer, the
   `pnpm sessions` command, unit tests for the fold.
5. `record-live` for Claude Code, producing raw Event fixtures and the first draft of
   `docs/agent-events.md`; verify the `session_id` source attribute against that recording.
6. Normaliser for Claude Code and Runner events; integration test green.
7. Harvest and redact Transcripts into fixtures. Claude Code parser with tests. Replayer.
8. Dashboard generators and `smoke`. Iterate until `smoke` passes on fixtures.
9. Probe Server and the MCP Servers dashboard. `pnpm mcp:conform` against the Probe Server.
   `smoke` again.
10. Runner: lifecycle, Claude Code Adapter, Checker, Results, report. `bench` with
    `--variant none`, then `--variant probe`.
11. `docs/adding-an-agent.md`, written from the experience of building the Claude Code Adapter.
    README. Final `test` and `smoke`.

## Constraints and conventions

- Schema-first TypeScript: every external shape (Task, Config, Event, OTLP payload, Results row,
  dashboard model) has a Zod schema; types are derived from the schemas, never written twice.
- Strict tsconfig. Test-driven development for parsers, the redactor, the Session fold,
  aggregation and the report query: tests first.
- Functional style: pure functions for parsing, normalising, folding and aggregating; side
  effects (spawn, file system, HTTP, DuckDB) at the edges only.
- Nothing in any Agent's request path. No proxies, no hooks, no wrappers, no monkey-patching.
  Only environment variables and per-Run configuration files.
- Never modify `~/.claude`, `~/.codex` or `~/.gemini`. Per-Run configuration lives under
  `runs/<run_id>/`.
- Pin every image tag and dependency version.
- Dashboards are code: generated into `compose/grafana/dashboards/` and committed; never edited
  in the Grafana user interface.
- Plain English in README and docs. Short sentences. Every acronym expanded on first use.
- Glossary terms are used verbatim in identifiers, file names, dashboard titles and docs.

## Verify on the machine before building

First ten minutes of the build. Record the answers at the top of `docs/agent-events.md`.

- [ ] Host operating system and shell (affects bind-mount paths, Transcript paths and process
      signals).
- [ ] `claude --version` and `claude --help`: confirm `-p`, `--output-format`, `--mcp-config`,
      `--strict-mcp-config` and the permissions flag; note the exact names. (Verified here:
      Claude Code 2.1.270 installed.)
- [ ] `codex --version`, `gemini --version`: installed or not. (Verified here: both report
      command not found; see "Agents not yet supported".)
- [ ] `docker compose version` supports `--wait`. Node 22 or newer (22.18.0 verified here). pnpm
      present (10.31.0 verified here).
- [ ] Count Claude Code Transcripts under `~/.claude/projects`: enough sessions with tool calls
      for 20 fixtures.
- [ ] Run `record-live` once with `OTEL_RESOURCE_ATTRIBUTES=run_id=probe` and confirm the
      recorded Events carry it. If not, implement the time-window fallback.
- [ ] From that recording, confirm where Claude Code puts the event name (attribute vs record
      field) before writing the transform rules.
- [ ] Confirm how a tool named `mcp__<server>__<tool>` is actually reported by the installed
      Agent, including the exact delimiter, before relying on it to derive `mcp_server` and
      `tool_type`.

Open questions, defaults applied if unanswered: unrecorded warm-cache priming Runs are not
written to the `sessions` or `runs` tables; the `hello` Task is "create `hello.txt` containing
the word hello" with Checker `test -f hello.txt`.

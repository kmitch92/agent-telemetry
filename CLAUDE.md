# CLAUDE.md

Instructions for an automated coding session working in this repository.

## Read first

SPEC.md at the repository root is the single source of truth for
architecture, names, and acceptance criteria. A session must read the
sections of SPEC.md relevant to its task before it writes code. A session
must not invent a design that SPEC.md does not describe.

When the code and SPEC.md disagree, the session stops and reports the
disagreement. The session does not choose a side. It names the file, the
line, and the exact contradiction, then waits.

## Vocabulary

Use these terms verbatim, in identifiers, file names, dashboard titles,
commit messages, and prose. Do not substitute a synonym.

| Term | Meaning |
| --- | --- |
| Agent | A coding-agent command-line tool, for example `claude-code`. |
| Session | One continuous conversation with one Agent, keyed by the identifier the Agent emits. |
| Project | A stable short identifier for a working directory. |
| Event | One OTLP log record. |
| Kind | The normalised event type: `model_call`, `tool_call`, `prompt`, `api_error`, `mcp_server_call`, `run_start`, `run_end`. |
| Normaliser | The collector transform stage. |
| Stack | The four compose services: Collector, Loki, Prometheus, Grafana. |
| Runner | The optional task-executing command-line interface. |
| Run | One Task under one Variant, one repetition, keyed by `run_id`. |
| Task | A YAML file. |
| Variant | A named set of MCP servers from `configs/variants.yaml`. |
| Fixture | A project folder copied fresh for every Run. |
| Checker | A command run after the Agent exits; exit code 0 means pass. |
| Adapter | The per-Agent module. |
| Transcript | The session log an Agent writes on its own. |
| Replayer | Turns Transcripts and recorded Events into OTLP. |
| Probe Server | The in-repo reference MCP server used for tests. |
| Session index | The fold from Events to one row per Session. |

Forbidden words: the words broker, arm, harness, and "raw MCP" must never
appear in code, file names, comments, dashboards, documentation, or commit
messages in this repository. A session that finds one of these words fixes
it as part of its change.

## Hard prohibitions

1. Never modify, wrap, proxy, hook, or otherwise sit in an Agent's request
   path. This system receives only what Agents and MCP servers emit
   outward on their own. The only permitted influence on an Agent is an
   environment variable and a per-Run configuration file inside
   `runs/<run_id>/`.
2. Never read, write, or delete anything under `~/.claude`, `~/.codex`, or
   `~/.gemini`, except reading Transcript files for the harvest step.
3. Never export prompt text, tool input, or tool output. Prompt-logging
   switches stay off.
4. Never commit an unredacted capture, a secret, or an absolute
   home-directory path.
5. Never make a dashboard panel pass by writing fabricated Events. A panel
   that no real or replayed Event can fill is deleted and listed under
   Known gaps in README.md.
6. Never `git push`, never rewrite history, never `git reset --hard`,
   never force-push. Commit only when asked.
7. Never start a paid or long-running Agent session on your own
   initiative. The one exception is a step whose stated purpose is to
   record live telemetry, which uses a single trivial prompt.

## Engineering rules

- Schema first: every external shape has a Zod schema in `src/schema/`,
  and the TypeScript type comes from `z.infer`. Never write a type twice.
- Functional core, imperative shell: parsing, normalising, folding, and
  aggregating are pure functions. Process spawn, file system, HTTP, and
  DuckDB live only in thin edge modules.
- Test first for parsers, the redactor, the Session fold, aggregation,
  and the report query. Write the failing test, see it fail, then make it
  pass.
- TypeScript strict. No `any`. No non-null assertion. No `as` cast to
  escape a type error: fix the type instead.
- Exact dependency versions, no caret and no tilde. Pinned Docker image
  tags.
- One logical change per commit, conventional commit message.

## Commands

| Command | What it does |
| --- | --- |
| `compose:up` | Starts the Stack. |
| `compose:down` | Stops the Stack and removes its containers. |
| `smoke` | Runs a quick end-to-end check against the running Stack. |
| `replay` | Turns recorded Events or Transcripts into OTLP output. |
| `record` | Starts a real Agent session to capture live telemetry. Costs money. |
| `harvest` | Reads Transcript files and extracts Events from them. |
| `sessions` | Builds the Session index from stored Events. |
| `bench` | Runs the Runner across Tasks and Variants with a real Agent. Costs money. |
| `report` | Runs the report query and prints aggregated results. |
| `mcp:conform` | Checks an MCP server against the expected contract. |
| `dashboards:build` | Generates Grafana dashboard definitions from source. |
| `test` | Runs the unit test suite. |
| `typecheck` | Runs the TypeScript compiler in check-only mode. |
| `lint` | Runs the linter. |
| `verify` | Runs typecheck, lint, and test together. |

Only `bench` and `record` start a real Agent. Do not run either one
without an explicit instruction from the user for that specific run.

## Before you finish

Run this checklist before reporting a task done:

- `pnpm verify` passes.
- Only the test files relevant to the change were run. Never run the
  whole suite unless asked.
- No forbidden word was introduced. Prove it with:
  `grep -rniE "\bbroker\b|\barm\b|\bharness\b|raw MCP" --exclude-dir=node_modules --exclude-dir=.git --exclude=CLAUDE.md --exclude=tickets.yaml .`
  The command must return no matches. CLAUDE.md and tickets.yaml state the
  rule and therefore contain the words on purpose, so they are excluded.
- No file outside the task's stated scope was touched.
- The working tree contains no unredacted capture.

## When blocked

Stop. Report what failed, with the single most informative line of
output. Wait for the next instruction.

Do not work around a blocker by weakening a test, deleting an assertion,
or widening a type.

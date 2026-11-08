# MCP server event contract

This file is a standalone specification. An MCP (Model Context Protocol) server
author must be able to implement this contract from this file alone, with no
other file open. This contract is optional and additive. An MCP server that
implements none of it still works fully with this system; it simply reports no
internals about itself, and the rest of the system continues to function
without that detail. This repository owns this contract and specifies it here.
The contract is not borrowed from any external document, and it names no
outside standard as its source.

A server that wants to report its own internals follows every rule below. A
server that does not want to report anything need not read further than this
paragraph.

## Primary event

The primary event name is `mcp_server.call`. A conforming server sets this
name in two places on the same log record: the log record's own event-name
field, and an attribute with key `event.name` carrying the same string value.
A conforming server emits exactly one `mcp_server.call` event per `tools/call`
request it receives, whether that call succeeded or failed.

## MUST attributes

Every `mcp_server.call` event carries all of the following attributes. A
reader may assume each one is present, with the correct type, on every event
of this name.

| Attribute | Type | Notes |
| --- | --- | --- |
| `mcp_server.call_id` | string | A ULID (Universally Unique Lexicographically Sortable Identifier). Unique per event. |
| `mcp.method.name` | string | The Model Context Protocol method name the request invoked. |
| `gen_ai.tool.name` | string | The name of the tool the request invoked. |
| `mcp_server.total_ms` | int | Wall-clock duration of the whole call, in milliseconds. |
| `mcp_server.status` | enum | One of `ok`, `error`. |
| `mcp_server.error.type` | enum | Required only when `mcp_server.status` is `error`. Closed set: `no_target`, `upstream_http`, `upstream_timeout`, `upstream_connect`, `bad_request`, `internal`. Absent when status is `ok`. |
| `mcp_server.upstream_ms` | int | Required only when the server made an upstream request as part of handling the call. In every other case this attribute is a SHOULD, not a MUST; see the SHOULD table below for its general description. |

## SHOULD attributes

A conforming server is encouraged to carry these attributes when it has the
information to fill them, but none is required for conformance, except that
`mcp_server.upstream_ms` becomes a MUST in the one condition stated above and
in the MUST table.

| Attribute | Type | Notes |
| --- | --- | --- |
| `mcp_server.internal_ms` | int | Time spent in the server's own logic, excluding any upstream wait. |
| `mcp_server.upstream_ms` | int | Time spent waiting on an upstream request. MUST be present when the server made an upstream request; otherwise SHOULD. |
| `mcp_server.upstream.service` | string | The name of the upstream service the server called. |
| `mcp_server.upstream.status` | int | The status code the upstream service returned. |
| `mcp_server.upstream.attempts` | int | How many attempts the server made against the upstream service. |
| `mcp_server.target` | string | For a server that routes a request to one of several named targets, the chosen target, in the form `<service>.<operation>`. |
| `mcp_server.route.confidence` | number | A value from 0 to 1, how confident the server's routing logic was in its choice of target. |
| `mcp_server.cache` | enum | One of `hit`, `miss`, `bypass`, `stale`. |
| `mcp_server.raw_bytes` | int | Size, in bytes, of the unprocessed upstream payload before the server shaped it. |
| `mcp_server.returned_bytes` | int | Size, in bytes, of the payload the server returned to the Agent. |
| `mcp_server.request_bytes` | int | Size, in bytes, of the request the server received. |
| `mcp_server.error.message` | string | A short error message, 256 characters maximum. Must not carry request or response text; see Transport rules. |
| `mcp.tool.is_error` | bool | Whether the tool result itself represents an error condition. |
| `mcp.request.id` | string | The Model Context Protocol request identifier. |
| `mcp.session.id` | string | The Model Context Protocol session identifier, if the transport carries one. |
| `mcp.client.name` | string | The name the connecting client (an Agent) announced. |
| `mcp.client.version` | string | The version the connecting client (an Agent) announced. |
| `service.version` | string | The server's own version. |

## Resource attributes

Every log record a conforming server emits carries a resource. On that
resource:

- `service.name` is the server's own name, for example the name it would print
  for a `--version` flag. It is never a fixed constant shared by every server;
  each server names itself.
- The server reads the environment variable `OTEL_RESOURCE_ATTRIBUTES`
  (OpenTelemetry Protocol resource attributes, a comma-separated `key=value`
  list) once at start-up and parses it. When the keys `run_id`, `task`,
  `variant`, or `config` are present in that variable, the server carries each
  one through to its own resource unchanged. A key absent from the variable is
  simply absent from the resource; the server does not invent a value for it.

## Secondary events

A conforming server may additionally emit any of the following four event
names. All four are SHOULD, none is MUST. A server that emits none of them,
and only ever emits `mcp_server.call`, still conforms fully.

- `mcp_server.start`
- `mcp_server.upstream.error`
- `mcp_server.cache.evict`
- `mcp_server.cache.flush`

This specification places no attribute requirement on any of the four. A
server that chooses to emit one of them may shape it as it sees fit.

## Transport rules

Every rule below is a MUST unless its own sentence says otherwise.

- The server sends its events as OTLP (OpenTelemetry Protocol) over HTTP,
  using the log signal. It sends a POST request to `<endpoint>/v1/logs`,
  where `<endpoint>` is the value described next.
- The endpoint comes from the environment variable
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- When that variable is unset, telemetry is off for that server process, and
  the server makes zero network calls for telemetry. This is the default
  state: a server with no environment variable set sends nothing and dials
  nothing.
- The server uses a batch log record processor. That processor has a
  scheduled delay of 1 second and an export timeout of 2 seconds.
- The server flushes its pending batch on receiving `SIGTERM`, on receiving
  `SIGINT`, and on its standard input closing. Each of these three flushes is
  capped at 2 seconds; the server does not wait past that cap before exiting.
- The server builds the event record during the call itself, but it hands
  that record to the batch processor only after it has written the response
  back to the caller. It never delays the response to build or send telemetry.
- The server never awaits an export call inside the request-handling path.
  Sending telemetry never slows down or blocks a `tools/call` response.
- The server never throws, and never crashes, because of a telemetry failure.
  When the collector is unreachable, the server writes one line to standard
  error at the first such failure only, and stays silent about every
  subsequent failure of the same kind.
- No attribute value the server emits is over 2 kilobytes.
- No attribute the server emits carries request text or response text, in
  full or in part. This rule covers every attribute on every event the server
  emits, not only the ones this contract names, including
  `mcp_server.error.message`.

## Conformance procedure

A server is checked against this contract with one command:

```
pnpm mcp:conform -- <command that starts the server>
```

The check runs five steps, in order.

1. **Start.** The checker starts the server over standard input and standard
   output (stdio), with two environment variables set:
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` and
   `OTEL_RESOURCE_ATTRIBUTES=run_id=conform-<ulid>`, where `<ulid>` is a fresh
   ULID generated for that run of the checker.
2. **Drive.** The checker sends a fixed script of requests to the server:
   one `initialize` request, then six distinct `tools/call` requests, then
   the same six requests again (a server that caches is expected to answer
   this second set of six from its cache, producing cache hits), then one
   request the checker has deliberately made invalid, and finally the checker
   closes standard input.
3. **Settle.** The checker then waits for the settle rule: it treats the
   server as finished once 5 seconds pass with no new line appended to
   `data/events.jsonl`, and it gives up waiting after 30 seconds in total
   regardless.
4. **Assert.** The checker then checks all of the following:
   - Exactly thirteen `mcp_server.call` events exist. Thirteen is 6 (the
     first set of distinct calls) plus 6 (the repeated set) plus 1 (the
     invalid request), for 6 + 6 + 1 = 13.
   - Every one of those thirteen events carries its own `mcp_server.call_id`,
     and no two events share a `mcp_server.call_id`.
   - Every MUST attribute from the MUST attributes table above is present on
     every event, holding the correct type, and, for an enum attribute,
     holding a value from that attribute's closed set.
   - The deliberately invalid request's event carries `mcp_server.status`
     equal to `error`, together with an `mcp_server.error.type` value drawn
     from the closed set in the MUST attributes table.
   - No attribute value on any event is over 2 kilobytes.
   - No attribute value on any event contains the request text the checker
     sent.
   - The resource attribute `run_id` is present on every event.
   - A failure of any check in this step 4 is a MUST failure.
   The checker also looks for two further conditions, and treats each as a
   warning rather than a failure: a SHOULD attribute missing from one or more
   events, and the complete absence of an `mcp_server.start` event.
5. **Exit.** The checker exits with a non-zero status when step 4 found any
   MUST failure, and exits zero otherwise, regardless of how many warnings
   step 4 produced.

## Worked example

The following is one valid OTLP (OpenTelemetry Protocol) over HTTP log
payload, carrying a single `mcp_server.call` event, shaped as the
`resourceLogs` / `scopeLogs` / `logRecords` structure this transport uses.

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "example-mcp-server" } },
          { "key": "run_id", "value": { "stringValue": "conform-01JB3X9K7ZC2V9H8G5T1Q6R4N8" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "example-mcp-server" },
          "logRecords": [
            {
              "timeUnixNano": "1730000000123456789",
              "eventName": "mcp_server.call",
              "attributes": [
                { "key": "event.name", "value": { "stringValue": "mcp_server.call" } },
                { "key": "mcp_server.call_id", "value": { "stringValue": "01JB3XA1M5D3W7K2P9Q0R6T8V2" } },
                { "key": "mcp.method.name", "value": { "stringValue": "tools/call" } },
                { "key": "gen_ai.tool.name", "value": { "stringValue": "probe" } },
                { "key": "mcp_server.total_ms", "value": { "intValue": "187" } },
                { "key": "mcp_server.status", "value": { "stringValue": "ok" } },
                { "key": "mcp_server.internal_ms", "value": { "intValue": "42" } },
                { "key": "mcp_server.upstream_ms", "value": { "intValue": "145" } },
                { "key": "mcp_server.upstream.service", "value": { "stringValue": "catalogue-lookup" } },
                { "key": "mcp_server.upstream.status", "value": { "intValue": "200" } },
                { "key": "mcp_server.cache", "value": { "stringValue": "miss" } },
                { "key": "mcp.request.id", "value": { "stringValue": "7" } },
                { "key": "service.version", "value": { "stringValue": "1.0.0" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

In this payload, `service.name` and `run_id` sit on the resource, exactly as
the Resource attributes section requires. The log record carries
`eventName` set to `mcp_server.call`, and an `event.name` attribute carrying
the same string, satisfying the Primary event rule's requirement for both
places at once. Every attribute the MUST attributes table names is present
with its stated type, the call made an upstream request so
`mcp_server.upstream_ms` is present as that condition demands, and several
SHOULD attributes appear alongside them without being required.

import { z } from 'zod';
import { AnyValueSchema } from '../events/otlp-payload.js';

/**
 * A lenient OTLP (OpenTelemetry Protocol) log line schema for the
 * conformance checker. "Lenient" means this schema accepts what an
 * arbitrary third-party MCP (Model Context Protocol) server emits, not only
 * what this repository's own writer produces: every OTLP field beyond the
 * few this schema names as required stays optional, including
 * `severityText`, `severityNumber`, `observedTimeUnixNano` and `scope`.
 * `AnyValueSchema` is reused unchanged from `../events/otlp-payload.js`, so
 * an unknown value form, such as `{ bytesValue: 'x' }`, still fails here
 * exactly as it fails there.
 */

export const ConformOtlpAttributeSchema = z.object({
  key: z.string(),
  value: AnyValueSchema,
});

export type ConformOtlpAttribute = z.infer<typeof ConformOtlpAttributeSchema>;

export const ConformLogRecordSchema = z.object({
  timeUnixNano: z.string(),
  eventName: z.string().optional(),
  attributes: z.array(ConformOtlpAttributeSchema),
});

export type ConformLogRecord = z.infer<typeof ConformLogRecordSchema>;

export const ConformScopeLogsSchema = z.object({
  logRecords: z.array(ConformLogRecordSchema),
});

export type ConformScopeLogs = z.infer<typeof ConformScopeLogsSchema>;

export const ConformResourceLogsSchema = z.object({
  resource: z.object({ attributes: z.array(ConformOtlpAttributeSchema) }),
  scopeLogs: z.array(ConformScopeLogsSchema),
});

export type ConformResourceLogs = z.infer<typeof ConformResourceLogsSchema>;

export const ConformOtlpLineSchema = z.object({
  resourceLogs: z.array(ConformResourceLogsSchema),
});

export type ConformOtlpLine = z.infer<typeof ConformOtlpLineSchema>;

export const CheckSeveritySchema = z.enum(['must', 'warn']);

export type CheckSeverity = z.infer<typeof CheckSeveritySchema>;

export const CheckResultSchema = z.object({
  id: z.string(),
  severity: CheckSeveritySchema,
  pass: z.boolean(),
  detail: z.string(),
});

export type CheckResult = z.infer<typeof CheckResultSchema>;

/**
 * A lenient, recursive JSON Schema node, as returned inside a `tools/list`
 * result's `inputSchema`. This is the single declaration of the
 * `JsonSchemaNode` shape: `src/conform/script.ts` re-exports this type rather
 * than declaring its own. `z.lazy` provides the recursion through
 * `properties`, and `z.looseObject` tolerates every key an arbitrary MCP
 * (Model Context Protocol) server's JSON Schema may carry beyond the three
 * named here, such as `additionalProperties` or `description`.
 */
export interface JsonSchemaNode {
  type?: string | undefined;
  required?: string[] | undefined;
  properties?: Record<string, JsonSchemaNode> | undefined;
}

export const JsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.looseObject({
    type: z.string().optional(),
    required: z.array(z.string()).optional(),
    properties: z.record(z.string(), JsonSchemaNodeSchema).optional(),
  }),
);

/** One entry of a `tools/list` result, as the Model Context Protocol defines it. */
export const ToolDescriptorSchema = z.looseObject({
  name: z.string(),
  inputSchema: JsonSchemaNodeSchema.optional(),
});

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** The `result` payload of a `tools/list` JSON-RPC response. */
export const ToolsListResultSchema = z.object({
  tools: z.array(ToolDescriptorSchema),
});

export type ToolsListResult = z.infer<typeof ToolsListResultSchema>;

/**
 * A lenient JSON-RPC 2.0 response frame, as the Model Context Protocol
 * stdio transport sends it, one per line. `result` stays `z.unknown()`
 * because its shape depends on the request method; a caller narrows it with
 * its own schema, such as `ToolsListResultSchema`.
 */
export const JsonRpcResponseSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.number(),
      message: z.string(),
    })
    .optional(),
});

export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

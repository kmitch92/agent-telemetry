import { z } from 'zod';
import { ResourceAttributesSchema } from './resource.js';

const Count = z.number().int().nonnegative();

export const KindSchema = z.enum([
  'model_call',
  'tool_call',
  'prompt',
  'api_error',
  'mcp_server_call',
  'run_start',
  'run_end',
]);

export type Kind = z.infer<typeof KindSchema>;

export const ModelCallEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('model_call'),
  model: z.string().min(1),
  input_tokens: Count.optional(),
  output_tokens: Count.optional(),
  cache_read_tokens: Count.optional(),
  cache_write_tokens: Count.optional(),
  reasoning_tokens: Count.optional(),
  duration_ms: Count.optional(),
  cost_usd: z.number().nonnegative().optional(),
});

export type ModelCallEvent = z.infer<typeof ModelCallEventSchema>;

export const ToolCallEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('tool_call'),
  tool: z.string().min(1),
  success: z.boolean(),
  tool_type: z.enum(['mcp', 'native']),
  duration_ms: Count.optional(),
  result_bytes: Count.optional(),
  mcp_server: z.string().min(1).optional(),
});

export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

export const PromptEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('prompt'),
  prompt_length: Count,
});

export type PromptEvent = z.infer<typeof PromptEventSchema>;

export const ApiErrorEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('api_error'),
  error_type: z.string().min(1),
  model: z.string().min(1).optional(),
  attempt: Count.optional(),
  status_code: z.number().int().optional(),
});

export type ApiErrorEvent = z.infer<typeof ApiErrorEventSchema>;

const McpServerCallErrorTypeSchema = z.enum([
  'no_target',
  'upstream_http',
  'upstream_timeout',
  'upstream_connect',
  'bad_request',
  'internal',
]);

const mcpServerCallErrorRefinement = (
  data: Record<string, unknown>,
  ctx: z.core.$RefinementCtx,
): void => {
  if (data['mcp_server.status'] === 'error' && data['mcp_server.error.type'] === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'mcp_server.error.type is required when mcp_server.status is "error"',
      path: ['mcp_server.error.type'],
    });
  }
};

export const McpServerCallEventSchema = z
  .looseObject({
    ...ResourceAttributesSchema.shape,
    kind: z.literal('mcp_server_call'),
    'mcp_server.call_id': z.string().min(1),
    'mcp.method.name': z.string().min(1),
    'gen_ai.tool.name': z.string().min(1),
    'mcp_server.total_ms': Count,
    'mcp_server.status': z.enum(['ok', 'error']),
    'mcp_server.error.type': McpServerCallErrorTypeSchema.optional(),
    'mcp_server.internal_ms': Count.optional(),
    'mcp_server.upstream_ms': Count.optional(),
    'mcp_server.upstream.status': Count.optional(),
    'mcp_server.upstream.attempts': Count.optional(),
    'mcp_server.raw_bytes': Count.optional(),
    'mcp_server.returned_bytes': Count.optional(),
    'mcp_server.request_bytes': Count.optional(),
    'mcp_server.upstream.service': z.string().min(1).optional(),
    'mcp_server.target': z.string().min(1).optional(),
    'mcp.request.id': z.string().min(1).optional(),
    'mcp.session.id': z.string().min(1).optional(),
    'mcp.client.name': z.string().min(1).optional(),
    'mcp.client.version': z.string().min(1).optional(),
    'service.version': z.string().min(1).optional(),
    'mcp_server.error.message': z.string().max(256).optional(),
    'mcp_server.route.confidence': z.number().min(0).max(1).optional(),
    'mcp_server.cache': z.enum(['hit', 'miss', 'bypass', 'stale']).optional(),
    'mcp.tool.is_error': z.boolean().optional(),
  })
  .superRefine(mcpServerCallErrorRefinement);

export type McpServerCallEvent = z.infer<typeof McpServerCallEventSchema>;

export const RunStartEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('run_start'),
  rep: Count,
});

export type RunStartEvent = z.infer<typeof RunStartEventSchema>;

export const RunEndEventSchema = ResourceAttributesSchema.extend({
  kind: z.literal('run_end'),
  rep: Count,
  wall_ms: Count,
  turns: Count,
  tool_calls: Count,
  mcp_server_calls: Count,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  pass: z.boolean(),
  timed_out: z.boolean(),
  expected_tools_hit: z.boolean(),
  exit_code: z.number().int().optional(),
});

export type RunEndEvent = z.infer<typeof RunEndEventSchema>;

export const EventSchema = z.discriminatedUnion('kind', [
  ModelCallEventSchema,
  ToolCallEventSchema,
  PromptEventSchema,
  ApiErrorEventSchema,
  McpServerCallEventSchema,
  RunStartEventSchema,
  RunEndEventSchema,
]);

export type Event = z.infer<typeof EventSchema>;

import { z } from 'zod';

const Count = z.number().int().nonnegative();

/**
 * A DuckDB row always has every column, so absence of a value is `null`,
 * never an absent key.
 */
export const SessionRowSchema = z.object({
  session_id: z.string().min(1),
  agent: z.string().min(1),
  project: z.string().min(1),
  project_path: z.string().min(1),
  started_at: z.iso.datetime(),
  last_event_at: z.iso.datetime(),
  closed: z.boolean(),
  synthetic_session_id: z.boolean(),
  model_calls: Count,
  tool_calls: Count,
  mcp_server_calls: Count,
  prompts: Count,
  api_errors: Count,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  cache_write_tokens: Count,
  reasoning_tokens: Count,
  cost_usd: z.number().nonnegative().nullable(),
  wall_ms: Count,
  run_id: z.string().min(1).nullable(),
  task: z.string().min(1).nullable(),
  variant: z.string().min(1).nullable(),
});

export type SessionRow = z.infer<typeof SessionRowSchema>;

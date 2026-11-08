import { z } from 'zod';

const Count = z.number().int().nonnegative();

export const ResultsRowSchema = z.object({
  run_id: z.string().min(1),
  started_at: z.iso.datetime(),
  task: z.string().min(1),
  agent: z.string().min(1),
  variant: z.string().min(1),
  cache: z.enum(['cold', 'warm']),
  rep: Count,
  pass: z.boolean(),
  exit_code: z.number().int().nullable(),
  timed_out: z.boolean(),
  wall_ms: Count,
  turns: Count,
  tool_calls: Count,
  mcp_server_calls: Count,
  input_tokens: Count,
  output_tokens: Count,
  cache_read_tokens: Count,
  input_tokens_per_turn: z.number().nonnegative(),
  cost_usd: z.number().nonnegative().nullable(),
  expected_tools_hit: z.boolean(),
  cache_hits: Count,
  checker_output: z.string(),
});

export type ResultsRow = z.infer<typeof ResultsRowSchema>;

import { z } from 'zod';

export const ReportRowSchema = z.object({
  task: z.string().min(1),
  variant: z.string().min(1),
  n: z.number().int().positive(),
  pass_rate: z.number().min(0).max(1),
  median_turns: z.number().nonnegative(),
  median_input_tokens_per_turn: z.number().nonnegative(),
  median_wall_ms: z.number().nonnegative(),
  p95_tool_ms: z.number().nonnegative().nullable(),
});

export type ReportRow = z.infer<typeof ReportRowSchema>;

export const ReportOutputSchema = z.object({
  rows: z.array(ReportRowSchema),
  adhoc_sessions: z.number().int().nonnegative(),
});

export type ReportOutput = z.infer<typeof ReportOutputSchema>;

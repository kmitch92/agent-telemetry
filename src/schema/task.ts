import { z } from 'zod';

export const TaskSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  prompt: z.string().min(1),
  fixture: z.string().min(1),
  checker: z.string().min(1),
  expected_tools: z.array(z.string().min(1)).default([]),
  timeout_s: z.number().int().positive().default(600),
  tags: z.array(z.string().min(1)).default([]),
});

export type Task = z.infer<typeof TaskSchema>;

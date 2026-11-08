import { z } from 'zod';

/**
 * Resource attributes carried by every Event.
 *
 * `config` is an opaque, non-empty text label. SPEC.md names the `config`
 * attribute at four places and never defines its content, so it is modeled
 * here as a plain non-empty string.
 */
export const ResourceAttributesSchema = z.object({
  agent: z.string().min(1),
  session_id: z.string().min(1),
  project: z.string().min(1),
  run_id: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  variant: z.string().min(1).optional(),
  config: z.string().min(1).optional(),
});

export type ResourceAttributes = z.infer<typeof ResourceAttributesSchema>;

import { z } from 'zod';

export const McpServerSchema = z.strictObject({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().min(1), z.string()).default({}),
});

export type McpServer = z.infer<typeof McpServerSchema>;

export const VariantSchema = z.strictObject({
  servers: z.array(McpServerSchema).default([]),
});

export type Variant = z.infer<typeof VariantSchema>;

export const VariantsFileSchema = z.strictObject({
  variants: z.record(z.string().min(1), VariantSchema),
});

export type VariantsFile = z.infer<typeof VariantsFileSchema>;

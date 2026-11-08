import { z } from 'zod';

/**
 * Zod schemas for the Claude Code Transcript line shapes (SPEC.md "Replayer
 * and test beds"). Every schema here is PERMISSIVE on purpose: a real
 * Transcript line carries many keys this repository does not model, and an
 * unknown key must never cause a loss, so every schema below is a
 * `z.looseObject` with every field optional except what the parser truly
 * needs.
 *
 * The parser reads the camelCase `sessionId` ONLY. It never reads the
 * snake_case `session_id`: one Fixture carries a `session_id` holding a
 * different identifier than its `sessionId` on 1868 lines (see
 * `test/fixtures/transcripts/claude-code/cb8551ba-886f-8e08-a493-e89d5abea374.jsonl:21`).
 */

export const UsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  // A live recording showed `output_tokens_details: null` on a `<synthetic>`
  // model line (`test/fixtures/transcripts/claude-code/5e3f77a0-874a-0fe5-8fd3-30c70845b1a2.jsonl:785`),
  // so `null` must parse as cleanly as an absent key: both mean "no detail".
  output_tokens_details: z
    .looseObject({
      thinking_tokens: z.number().int().nonnegative().optional(),
    })
    .nullable()
    .optional(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const ToolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
});

export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

export const ToolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.looseObject({}))]).optional(),
  is_error: z.boolean().optional(),
});

export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

export const TextBlockSchema = z.looseObject({
  type: z.literal('text'),
  text: z.string(),
});

export type TextBlock = z.infer<typeof TextBlockSchema>;

export const TranscriptLineSchema = z.looseObject({
  type: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  origin: z
    .looseObject({
      kind: z.string().optional(),
    })
    .optional(),
  message: z
    .looseObject({
      model: z.string().optional(),
      usage: UsageSchema.optional(),
      content: z.union([z.string(), z.array(z.looseObject({}))]).optional(),
    })
    .optional(),
});

export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

import { z } from 'zod';

export const DataSourceRefSchema = z.object({
  type: z.literal('loki'),
  uid: z.literal('loki'),
});

export type DataSourceRef = z.infer<typeof DataSourceRefSchema>;

export const GridPosSchema = z.object({
  h: z.number().int().positive(),
  w: z.number().int().positive(),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});

export type GridPos = z.infer<typeof GridPosSchema>;

export const LokiTargetSchema = z.object({
  refId: z.string().min(1),
  datasource: DataSourceRefSchema,
  editorMode: z.literal('code'),
  expr: z.string().min(1),
  queryType: z.enum(['range', 'instant']),
  instant: z.boolean(),
  range: z.boolean(),
  legendFormat: z.string().min(1).optional(),
});

export type LokiTarget = z.infer<typeof LokiTargetSchema>;

export const TransformationSchema = z.object({
  id: z.string().min(1),
  options: z.record(z.string(), z.unknown()),
});

export type Transformation = z.infer<typeof TransformationSchema>;

export const FieldConfigSchema = z.object({
  defaults: z.record(z.string(), z.unknown()),
  overrides: z.array(z.record(z.string(), z.unknown())),
});

export type FieldConfig = z.infer<typeof FieldConfigSchema>;

/**
 * `description` is `z.string().min(1)` on purpose: SPEC.md requires every
 * panel to carry a description naming what it shows and which Kind it
 * reads, so an empty description is a parse failure rather than a lint
 * note.
 */
export const PanelSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  datasource: DataSourceRefSchema,
  gridPos: GridPosSchema,
  targets: z.array(LokiTargetSchema),
  fieldConfig: FieldConfigSchema,
  options: z.record(z.string(), z.unknown()),
  transformations: z.array(TransformationSchema).optional(),
});

export type Panel = z.infer<typeof PanelSchema>;

/**
 * `allValue` is the literal `'.*'` and never `'.+'`, because `run_id`,
 * `task` and `variant` are absent on a Session recorded without the
 * Runner, and a Loki regex matcher of `.*` matches an absent label while
 * `.+` excludes the stream.
 */
export const TemplateVariableSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  type: z.literal('query'),
  datasource: DataSourceRefSchema,
  query: z.object({
    label: z.string().min(1),
    stream: z.string(),
    type: z.literal(1),
  }),
  refresh: z.literal(1),
  multi: z.literal(true),
  includeAll: z.literal(true),
  allValue: z.literal('.*'),
  current: z.object({
    selected: z.boolean(),
    text: z.array(z.string()),
    value: z.array(z.string()),
  }),
  options: z.array(z.unknown()),
  hide: z.literal(0),
  sort: z.number().int().min(0),
});

export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

export const DashboardSchema = z.object({
  uid: z.string().min(1),
  title: z.string().min(1),
  tags: z.array(z.string().min(1)),
  timezone: z.string(),
  editable: z.boolean(),
  schemaVersion: z.number().int(),
  version: z.number().int().min(0),
  refresh: z.string(),
  time: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  templating: z.object({ list: z.array(TemplateVariableSchema) }),
  panels: z.array(PanelSchema),
});

export type Dashboard = z.infer<typeof DashboardSchema>;

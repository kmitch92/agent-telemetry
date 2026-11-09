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

/**
 * The twelve Grafana panel `type` values the dashboards section builds
 * today (`table`, `timeseries`, `stat`, `bargauge`, `histogram`,
 * `barchart`) plus the exploratory-panel set the next phase needs
 * (`heatmap`, `gauge`, `piechart`, `xychart`, `state-timeline`, `trend`).
 * A panel of any other `type` string is a parse failure, so a typo in a
 * builder call site is caught at build time rather than rendered into the
 * committed JSON.
 */
export const PanelTypeSchema = z.enum([
  'timeseries',
  'heatmap',
  'histogram',
  'barchart',
  'bargauge',
  'stat',
  'gauge',
  'piechart',
  'table',
  'xychart',
  'state-timeline',
  'trend',
]);

export type PanelType = z.infer<typeof PanelTypeSchema>;

export const LegendOptionsSchema = z.strictObject({
  showLegend: z.boolean(),
  displayMode: z.enum(['list', 'table', 'hidden']),
  placement: z.enum(['bottom', 'right']),
  calcs: z.array(z.string()),
});

export type LegendOptions = z.infer<typeof LegendOptionsSchema>;

export const TooltipOptionsSchema = z.strictObject({
  mode: z.enum(['single', 'multi', 'none']),
  sort: z.enum(['none', 'asc', 'desc']),
});

export type TooltipOptions = z.infer<typeof TooltipOptionsSchema>;

export const ReduceOptionsSchema = z.strictObject({
  calcs: z.array(z.string()),
  fields: z.string(),
  values: z.boolean(),
});

export type ReduceOptions = z.infer<typeof ReduceOptionsSchema>;

export const FooterOptionsSchema = z.strictObject({
  show: z.boolean(),
  reducer: z.array(z.string()),
  countRows: z.boolean(),
  fields: z.string(),
});

export type FooterOptions = z.infer<typeof FooterOptionsSchema>;

export const StackingSchema = z.strictObject({
  mode: z.enum(['none', 'normal', 'percent']),
  group: z.string(),
});

export type Stacking = z.infer<typeof StackingSchema>;

export const CellOptionsSchema = z.strictObject({
  type: z.enum([
    'auto',
    'color-text',
    'color-background',
    'gauge',
    'json-view',
    'image',
    'sparkline',
  ]),
});

export type CellOptions = z.infer<typeof CellOptionsSchema>;

/**
 * A threshold step's `value` is nullable because Grafana always renders
 * the base step (the one every other step overrides) with a `value` of
 * `null`.
 */
export const ThresholdStepSchema = z.strictObject({
  color: z.string().min(1),
  value: z.number().nullable(),
});

export type ThresholdStep = z.infer<typeof ThresholdStepSchema>;

export const ThresholdsConfigSchema = z.strictObject({
  mode: z.enum(['absolute', 'percentage']),
  steps: z.array(ThresholdStepSchema).min(1),
});

export type ThresholdsConfig = z.infer<typeof ThresholdsConfigSchema>;

export const FieldColorSchema = z.strictObject({
  mode: z.enum(['thresholds', 'fixed', 'palette-classic']),
});

export type FieldColor = z.infer<typeof FieldColorSchema>;

/**
 * One entry of a Grafana `value`-type value mapping's `options` map: the
 * raw value (the `options` key, for example `"0"`) renders as `text`
 * (for example `"idle"`), with an optional `color` and an optional
 * `index` for the mapping's row order in Grafana's editor.
 */
export const ValueMappingOptionSchema = z.strictObject({
  text: z.string().min(1),
  color: z.string().min(1).optional(),
  index: z.number().int().min(0).optional(),
});

export type ValueMappingOption = z.infer<typeof ValueMappingOptionSchema>;

/**
 * A Grafana `value`-type value mapping (SPEC's live dashboards need this
 * to turn a number such as `0` or `1` into a word such as `idle` or
 * `working`). Grafana also supports `range`, `regex`, and `special`
 * mapping types; only `value` is modelled here, because it is the only
 * type the live dashboards need.
 */
export const ValueMappingSchema = z.strictObject({
  type: z.literal('value'),
  options: z.record(z.string(), ValueMappingOptionSchema),
});

export type ValueMapping = z.infer<typeof ValueMappingSchema>;

/**
 * A single value a panel's `custom` block can hold. Grafana never nests a
 * `custom` block more than one level deep for the panel types this module
 * builds, and the two nested shapes it does use (`cellOptions` for
 * `table`, `stacking` for `timeseries` and `barchart`) are the only
 * object-valued entries, so this union covers every value the four
 * committed dashboards and the exploratory panel types need.
 *
 * `custom` stays a `z.record` rather than a `z.object` on purpose:
 * `z.object` rebuilds its output in the shape's declared key order, which
 * would reorder a panel's `custom` block away from the order its builder
 * call site wrote, and the committed dashboard JSON would stop matching
 * byte for byte. `z.record` validates each entry's value against this
 * union but keeps the input's own key order, so every entry is typed and
 * no entry is `z.unknown()` or `z.any()`, without breaking that
 * byte-for-byte match.
 */
export const PanelCustomValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  CellOptionsSchema,
  StackingSchema,
]);

export const PanelCustomSchema = z.record(z.string(), PanelCustomValueSchema);

export type PanelCustom = z.infer<typeof PanelCustomSchema>;

/**
 * A single value a panel's `options` block can hold, for the same reason
 * and under the same `z.record`-not-`z.object` rule as
 * `PanelCustomValueSchema` above: the committed dashboards order an
 * `options` block's keys differently from one panel to the next (compare
 * the histogram panel's `bucketOffset`, `combine`, `legend` order against
 * the timeseries panels' `legend`, `tooltip` order), so only a `z.record`
 * preserves every panel's own key order.
 */
export const PanelOptionsValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  LegendOptionsSchema,
  TooltipOptionsSchema,
  ReduceOptionsSchema,
  FooterOptionsSchema,
]);

export const PanelOptionsSchema = z.record(z.string(), PanelOptionsValueSchema);

export type PanelOptions = z.infer<typeof PanelOptionsSchema>;

export const FieldConfigDefaultsSchema = z.strictObject({
  custom: PanelCustomSchema,
  unit: z.string().min(1).optional(),
  decimals: z.number().int().min(0).optional(),
  thresholds: ThresholdsConfigSchema.optional(),
  color: FieldColorSchema.optional(),
  max: z.number().optional(),
  /**
   * Turns a raw value, such as `0` or `1`, into a word, such as `idle`
   * or `working`. Optional and additive: a panel that omits it keeps
   * Grafana's own raw-value display exactly as before.
   */
  mappings: z.array(ValueMappingSchema).optional(),
  /**
   * What a stat panel shows instead of "No data" when a query returns
   * no series, for example `0` or `idle`. Optional and additive: a
   * panel that omits it keeps Grafana's own "No data" text exactly as
   * before.
   */
  noValue: z.string().min(1).optional(),
});

export type FieldConfigDefaults = z.infer<typeof FieldConfigDefaultsSchema>;

export const FieldConfigSchema = z.object({
  defaults: FieldConfigDefaultsSchema,
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
  type: PanelTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  datasource: DataSourceRefSchema,
  gridPos: GridPosSchema,
  targets: z.array(LokiTargetSchema),
  fieldConfig: FieldConfigSchema,
  options: PanelOptionsSchema,
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

/**
 * Grafana's time-range picker's own `refresh_intervals` list. Optional
 * and additive: a dashboard that omits it keeps Grafana's own default
 * picker options exactly as before. A live dashboard sets this to offer
 * `5s` and `10s`, which Grafana does not offer by default.
 */
export const TimePickerSchema = z.strictObject({
  refresh_intervals: z.array(z.string().min(1)),
});

export type TimePicker = z.infer<typeof TimePickerSchema>;

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
  timepicker: TimePickerSchema.optional(),
  templating: z.object({ list: z.array(TemplateVariableSchema) }),
  panels: z.array(PanelSchema),
});

export type Dashboard = z.infer<typeof DashboardSchema>;

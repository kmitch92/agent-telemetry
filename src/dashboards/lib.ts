import type {
  Dashboard,
  DataSourceRef,
  FieldColor,
  GridPos,
  LegendOptions,
  LokiTarget,
  Panel,
  PanelType,
  TemplateVariable,
  ThresholdsConfig,
  TimePicker,
  TooltipOptions,
  Transformation,
  ValueMapping,
} from '../schema/dashboard.js';
import {
  DashboardSchema,
  LokiTargetSchema,
  PanelSchema,
  TemplateVariableSchema,
  TransformationSchema,
  ValueMappingSchema,
} from '../schema/dashboard.js';

/**
 * Builders for the Grafana dashboard JSON (SPEC.md's dashboards section).
 * This module is pure: it never touches a file or a network socket. Every
 * builder returns the Zod-parsed, schema-validated shape, so a caller never
 * writes a malformed panel or dashboard by hand.
 */

export const LOKI_DATASOURCE: DataSourceRef = { type: 'loki', uid: 'loki' };

/**
 * `service_name=~".+"` anchors the selector: Loki rejects a stream selector
 * whose every matcher is empty-compatible (every `=~` matcher that can match
 * an absent label), and `service_name` is always present on every Event, so
 * this matcher guarantees the selector is never all empty-compatible.
 */
export const BASE_SELECTOR =
  '{service_name=~".+", agent=~"$agent", project=~"$project", session_id=~"$session_id", run_id=~"$run_id", task=~"$task", variant=~"$variant"}';

export function selector(kind?: string): string {
  return kind === undefined ? BASE_SELECTOR : `${BASE_SELECTOR} | kind="${kind}"`;
}

/**
 * `BASE_SELECTOR` plus the two stream labels only a live dashboard
 * filters by: `session_label` (a readable name such as
 * `agent-telemetry · main · 16:20`) and `branch`. Built from
 * `BASE_SELECTOR` itself, so the `$agent`, `$project`, `$session_id`,
 * `$run_id`, `$task`, and `$variant` filters stay identical, and never
 * mutates `BASE_SELECTOR`, so every committed, non-live dashboard JSON
 * stays byte-identical.
 */
export function liveSelector(kind?: string): string {
  const live = `${BASE_SELECTOR.slice(0, -1)}, session_label=~"$session_label", branch=~"$branch"}`;
  return kind === undefined ? live : `${live} | kind="${kind}"`;
}

/**
 * There is no `format` option here on purpose: Grafana's `LokiDataQuery`
 * declares no `format` field, and `queryType` alone decides whether the
 * datasource converts the response to a table.
 */
export function lokiTarget(input: {
  refId: string;
  expr: string;
  legendFormat?: string;
  instant?: boolean;
}): LokiTarget {
  const instant = input.instant ?? false;

  const built = {
    refId: input.refId,
    datasource: LOKI_DATASOURCE,
    editorMode: 'code',
    expr: input.expr,
    queryType: instant ? 'instant' : 'range',
    instant,
    range: !instant,
    ...(input.legendFormat !== undefined ? { legendFormat: input.legendFormat } : {}),
  };

  return LokiTargetSchema.parse(built);
}

/**
 * Sugar over `lokiTarget` for the common case of a panel, such as `stat`
 * or `table`, that always wants an instant query. `lokiTarget`'s own
 * `instant` behaviour is unchanged, so a caller that already passes
 * `instant: true` or `instant: false` to `lokiTarget` keeps working
 * unmodified.
 */
export function instantLokiTarget(input: {
  refId: string;
  expr: string;
  legendFormat?: string;
}): LokiTarget {
  return lokiTarget({ ...input, instant: true });
}

export function panel(input: {
  id: number;
  title: string;
  description: string;
  type: PanelType;
  gridPos: GridPos;
  targets: LokiTarget[];
  unit?: string;
  decimals?: number;
  thresholds?: ThresholdsConfig;
  colorMode?: FieldColor['mode'];
  max?: number;
  custom?: Record<string, unknown>;
  options?: Record<string, unknown>;
  legend?: LegendOptions;
  tooltip?: TooltipOptions;
  overrides?: Record<string, unknown>[];
  transformations?: Transformation[];
  mappings?: ValueMapping[];
  noValue?: string;
}): Panel {
  const defaults = {
    custom: input.custom ?? {},
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.decimals !== undefined ? { decimals: input.decimals } : {}),
    ...(input.thresholds !== undefined ? { thresholds: input.thresholds } : {}),
    ...(input.colorMode !== undefined ? { color: { mode: input.colorMode } } : {}),
    ...(input.max !== undefined ? { max: input.max } : {}),
    ...(input.mappings !== undefined ? { mappings: input.mappings } : {}),
    ...(input.noValue !== undefined ? { noValue: input.noValue } : {}),
  };

  const options = {
    ...(input.options ?? {}),
    ...(input.legend !== undefined ? { legend: input.legend } : {}),
    ...(input.tooltip !== undefined ? { tooltip: input.tooltip } : {}),
  };

  const built = {
    id: input.id,
    type: input.type,
    title: input.title,
    description: input.description,
    datasource: LOKI_DATASOURCE,
    gridPos: input.gridPos,
    targets: input.targets,
    fieldConfig: { defaults, overrides: input.overrides ?? [] },
    options,
    ...(input.transformations !== undefined ? { transformations: input.transformations } : {}),
  };

  return PanelSchema.parse(built);
}

/**
 * Builds a single Grafana `value`-type value mapping from a plain
 * record, for example `valueMapping({ '0': 'idle', '1': 'working' })`,
 * so a live panel can turn a raw number into a word without writing
 * Grafana's `{ type: 'value', options: { ... } }` shape by hand.
 */
export function valueMapping(values: Record<string, string>): ValueMapping {
  const options: Record<string, { text: string }> = {};
  for (const [value, text] of Object.entries(values)) {
    options[value] = { text };
  }

  const built = { type: 'value', options };

  return ValueMappingSchema.parse(built);
}

/**
 * Column ordering plus an `organize` transformation (SPEC's dashboards
 * section): hides `exclude`, orders `order`, and renames through
 * `rename`. The Sessions and Runs tables build this shape by hand today;
 * a new table panel can call this instead.
 */
export function organizeTransformation(input: {
  order: string[];
  rename?: Record<string, string>;
  exclude?: string[];
}): Transformation {
  const indexByName: Record<string, number> = {};
  input.order.forEach((name, index) => {
    indexByName[name] = index;
  });

  const excludeByName: Record<string, boolean> = {};
  for (const name of input.exclude ?? []) {
    excludeByName[name] = true;
  }

  const built = {
    id: 'organize',
    options: {
      excludeByName,
      includeByName: {},
      indexByName,
      renameByName: input.rename ?? {},
    },
  };

  return TransformationSchema.parse(built);
}

export function labelVariable(input: { name: string; label: string }): TemplateVariable {
  const built = {
    name: input.name,
    label: input.label,
    type: 'query',
    datasource: LOKI_DATASOURCE,
    query: { label: input.name, stream: '', type: 1 },
    refresh: 1,
    multi: true,
    includeAll: true,
    allValue: '.*',
    current: { selected: true, text: ['All'], value: ['$__all'] },
    options: [],
    hide: 0,
    sort: 1,
  };

  return TemplateVariableSchema.parse(built);
}

export function dashboard(input: {
  uid: string;
  title: string;
  panels: Panel[];
  variables: TemplateVariable[];
  /**
   * The dashboard's default time range. Optional and additive: a caller
   * that omits it keeps the long-standing "Last 24 hours" default exactly
   * as before, so every existing dashboard builder call is unaffected.
   */
  time?: { from: string; to: string };
  /**
   * The dashboard's own auto-refresh interval. Optional and additive: a
   * caller that omits it keeps the long-standing `'30s'` default exactly
   * as before, so every existing dashboard builder call is unaffected. A
   * live dashboard sets this to a faster interval such as `'5s'`.
   */
  refresh?: string;
  /**
   * Grafana's time-range picker's own `refresh_intervals` list. Optional
   * and additive: a caller that omits it keeps Grafana's own default
   * picker options exactly as before, so every existing dashboard
   * builder call is unaffected.
   */
  timepicker?: TimePicker;
}): Dashboard {
  const built = {
    uid: input.uid,
    title: input.title,
    tags: ['agent-telemetry'],
    timezone: 'browser',
    editable: false,
    schemaVersion: 39,
    version: 0,
    refresh: input.refresh ?? '30s',
    time: input.time ?? { from: 'now-24h', to: 'now' },
    ...(input.timepicker !== undefined ? { timepicker: input.timepicker } : {}),
    templating: { list: input.variables },
    panels: input.panels,
  };

  return DashboardSchema.parse(built);
}

export function renderDashboard(d: Dashboard): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

/**
 * Overrides a built Dashboard's default time range. `dashboard()` always
 * starts a new board at "now-24h", which is too narrow for a dashboard
 * built over Events that span a much longer capture window. Re-validates
 * through `DashboardSchema` so the override can never produce a malformed
 * `time` block, and never touches `dashboard()` itself, so every existing
 * caller keeps its unmodified "now-24h" default.
 */
export function withTimeRange(d: Dashboard, time: { from: string; to: string }): Dashboard {
  return DashboardSchema.parse({ ...d, time });
}

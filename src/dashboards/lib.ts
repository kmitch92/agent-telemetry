import type {
  Dashboard,
  DataSourceRef,
  GridPos,
  LokiTarget,
  Panel,
  TemplateVariable,
  Transformation,
} from '../schema/dashboard.js';
import {
  DashboardSchema,
  LokiTargetSchema,
  PanelSchema,
  TemplateVariableSchema,
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

export function panel(input: {
  id: number;
  title: string;
  description: string;
  type: string;
  gridPos: GridPos;
  targets: LokiTarget[];
  unit?: string;
  decimals?: number;
  custom?: Record<string, unknown>;
  options?: Record<string, unknown>;
  overrides?: Record<string, unknown>[];
  transformations?: Transformation[];
}): Panel {
  const defaults = {
    custom: input.custom ?? {},
    ...(input.unit !== undefined ? { unit: input.unit } : {}),
    ...(input.decimals !== undefined ? { decimals: input.decimals } : {}),
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
    options: input.options ?? {},
    ...(input.transformations !== undefined ? { transformations: input.transformations } : {}),
  };

  return PanelSchema.parse(built);
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
}): Dashboard {
  const built = {
    uid: input.uid,
    title: input.title,
    tags: ['agent-telemetry'],
    timezone: 'browser',
    editable: false,
    schemaVersion: 39,
    version: 0,
    refresh: '30s',
    time: { from: 'now-24h', to: 'now' },
    templating: { list: input.variables },
    panels: input.panels,
  };

  return DashboardSchema.parse(built);
}

export function renderDashboard(d: Dashboard): string {
  return `${JSON.stringify(d, null, 2)}\n`;
}

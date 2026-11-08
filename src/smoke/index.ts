import { DashboardSchema } from '../schema/dashboard.js';
import type { TemplateVariable } from '../schema/dashboard.js';

export { seriesCount } from '../schema/query-result.js';
export type { QueryResponse } from '../schema/query-result.js';

/**
 * The smoke check's pure core (SPEC.md "smoke"): extract Panel targets from
 * a parsed Grafana dashboard, substitute Grafana's `$` template variables
 * and macros out of a target's expr, and route the resulting query to Loki
 * or Prometheus by building the exact request url. Nothing in this module
 * performs I/O: `fetch`, `fs`, and `process.spawn` are forbidden here, and
 * the only permitted environment access is the base-url override below.
 */

export interface PanelTarget {
  dashboardFile: string;
  dashboardTitle: string;
  panelTitle: string;
  refId: string;
  expr: string;
  datasourceType: string;
  datasourceUid: string;
  instant: boolean;
}

export const LOKI_BASE_URL = process.env['SMOKE_LOKI_URL'] ?? 'http://localhost:3100';
export const PROMETHEUS_BASE_URL = process.env['SMOKE_PROMETHEUS_URL'] ?? 'http://localhost:9090';

export function extractTargets(input: { file: string; dashboard: unknown }): PanelTarget[] {
  const parsed = DashboardSchema.safeParse(input.dashboard);
  if (!parsed.success) {
    throw new Error(`Dashboard "${input.file}" failed to parse: ${parsed.error.message}`);
  }

  const dashboard = parsed.data;
  const targets: PanelTarget[] = [];

  for (const panel of dashboard.panels) {
    for (const target of panel.targets) {
      targets.push({
        dashboardFile: input.file,
        dashboardTitle: dashboard.title,
        panelTitle: panel.title,
        refId: target.refId,
        expr: target.expr,
        datasourceType: target.datasource.type,
        datasourceUid: target.datasource.uid,
        instant: target.queryType === 'instant',
      });
    }
  }

  return targets;
}

export interface DashboardCoverage {
  file: string;
  targets: readonly PanelTarget[];
}

/** Returns the dashboard file names among `entries` whose `targets` list is empty. */
export function assertAllDashboardsCovered(entries: readonly DashboardCoverage[]): string[] {
  return entries.filter((entry) => entry.targets.length === 0).map((entry) => entry.file);
}

const MACROS: Readonly<Record<string, string>> = {
  __range: '1h',
  __interval: '1m',
  __rate_interval: '1m',
  __auto: '1m',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceName(expr: string, name: string, value: string): string {
  const escaped = escapeRegExp(name);
  const pattern = new RegExp(`\\$\\{${escaped}\\}|\\$${escaped}(?![A-Za-z0-9_])`, 'g');
  return expr.replace(pattern, value);
}

function withWildcardFallback(value: string): string {
  return value.length > 0 ? value : '.*';
}

export function substituteQuery(input: {
  expr: string;
  variables: readonly TemplateVariable[];
}): string {
  let result = input.expr;

  for (const [name, value] of Object.entries(MACROS)) {
    result = replaceName(result, name, value);
  }

  for (const variable of input.variables) {
    result = replaceName(result, variable.name, withWildcardFallback(variable.allValue));
  }

  return result;
}

export interface QueryRequest {
  url: string;
  kind: 'loki' | 'prometheus';
}

export function requestFor(input: {
  target: PanelTarget;
  endMs: number;
  windowMs: number;
}): QueryRequest {
  const { target, endMs, windowMs } = input;
  const startMs = endMs - windowMs;

  if (target.datasourceType === 'loki') {
    if (target.instant) {
      const url = new URL(`${LOKI_BASE_URL}/loki/api/v1/query`);
      url.searchParams.set('query', target.expr);
      url.searchParams.set('time', String(endMs * 1_000_000));
      return { url: url.toString(), kind: 'loki' };
    }

    const url = new URL(`${LOKI_BASE_URL}/loki/api/v1/query_range`);
    url.searchParams.set('query', target.expr);
    url.searchParams.set('start', String(startMs * 1_000_000));
    url.searchParams.set('end', String(endMs * 1_000_000));
    url.searchParams.set('step', '60s');
    return { url: url.toString(), kind: 'loki' };
  }

  if (target.datasourceType === 'prometheus') {
    if (target.instant) {
      const url = new URL(`${PROMETHEUS_BASE_URL}/api/v1/query`);
      url.searchParams.set('query', target.expr);
      url.searchParams.set('time', String(Math.floor(endMs / 1000)));
      return { url: url.toString(), kind: 'prometheus' };
    }

    const url = new URL(`${PROMETHEUS_BASE_URL}/api/v1/query_range`);
    url.searchParams.set('query', target.expr);
    url.searchParams.set('start', String(Math.floor(startMs / 1000)));
    url.searchParams.set('end', String(Math.floor(endMs / 1000)));
    url.searchParams.set('step', '60');
    return { url: url.toString(), kind: 'prometheus' };
  }

  throw new Error(
    `Unsupported datasource type "${target.datasourceType}" for panel "${target.panelTitle}"`,
  );
}

export interface Failure {
  target: PanelTarget;
  query: string;
  reason: string;
}

export function formatFailureReport(failures: readonly Failure[]): string {
  if (failures.length === 0) {
    return '';
  }

  const blocks = failures.map((failure) =>
    [
      `Dashboard: ${failure.target.dashboardFile}`,
      `Panel: ${failure.target.panelTitle} (refId ${failure.target.refId})`,
      `Query: ${failure.query}`,
      `Reason: ${failure.reason}`,
    ].join('\n'),
  );

  return [...blocks, `${String(failures.length)} failure(s) total`].join('\n\n');
}

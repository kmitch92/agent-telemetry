import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TemplateVariableSchema } from '../src/schema/dashboard.js';
import type { TemplateVariable } from '../src/schema/dashboard.js';
import { QueryResponseSchema, seriesCount } from '../src/schema/query-result.js';
import {
  extractTargets,
  formatFailureReport,
  requestFor,
  substituteQuery,
} from '../src/smoke/index.js';
import type { Failure, PanelTarget } from '../src/smoke/index.js';

/**
 * Tests for the smoke check's pure core (SPEC.md "smoke"): extracting Panel
 * targets from a committed Grafana dashboard, substituting Grafana's `$`
 * template variables and macros, routing a query to Loki or Prometheus, and
 * counting series in a parsed query response. Group 1 reads the three real
 * committed dashboards under `compose/grafana/dashboards/`. Group 2 builds
 * synthetic PanelTarget and query-response literals by hand.
 */

const SESSIONS_FILE = 'compose/grafana/dashboards/sessions.json';
const TOOL_CALLS_FILE = 'compose/grafana/dashboards/tool-calls.json';
const RUNS_FILE = 'compose/grafana/dashboards/runs.json';

function readDashboard(fileName: string): unknown {
  const path = fileURLToPath(new URL(`../compose/grafana/dashboards/${fileName}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

const sessionsDashboardJson = readDashboard('sessions.json');
const toolCallsDashboardJson = readDashboard('tool-calls.json');
const runsDashboardJson = readDashboard('runs.json');

const TitleSchema = z.object({ title: z.string().min(1) });

const TemplatingListSchema = z.object({
  templating: z.object({ list: z.array(TemplateVariableSchema) }),
});

const sessionsVariables: readonly TemplateVariable[] =
  TemplatingListSchema.parse(sessionsDashboardJson).templating.list;
const toolCallsVariables: readonly TemplateVariable[] =
  TemplatingListSchema.parse(toolCallsDashboardJson).templating.list;

function targetFor(overrides: Partial<PanelTarget>): PanelTarget {
  return {
    dashboardFile: SESSIONS_FILE,
    dashboardTitle: 'Sessions',
    panelTitle: 'Sessions',
    refId: 'A',
    expr: '{service_name=~".+"}',
    datasourceType: 'loki',
    datasourceUid: 'loki',
    instant: true,
    ...overrides,
  };
}

describe('extractTargets', () => {
  it('returns 15 targets across 9 distinct panel titles for the real sessions dashboard', () => {
    const targets = extractTargets({ file: SESSIONS_FILE, dashboard: sessionsDashboardJson });

    expect(targets.length).toBe(15);
    expect(new Set(targets.map((target) => target.panelTitle)).size).toBe(9);
  });

  it('returns 8 targets across 7 distinct panel titles for the real tool-calls dashboard', () => {
    const targets = extractTargets({ file: TOOL_CALLS_FILE, dashboard: toolCallsDashboardJson });

    expect(targets.length).toBe(8);
    expect(new Set(targets.map((target) => target.panelTitle)).size).toBe(7);
  });

  it('returns an empty array and does not throw for the real runs dashboard, which has no panels', () => {
    let targets: PanelTarget[] = [];

    expect(() => {
      targets = extractTargets({ file: RUNS_FILE, dashboard: runsDashboardJson });
    }).not.toThrow();

    expect(targets).toEqual([]);
  });

  it('gives every tool-calls target a non-empty panelTitle, refId and expr, and the right dashboardFile and dashboardTitle', () => {
    const dashboardTitle = TitleSchema.parse(toolCallsDashboardJson).title;
    const targets = extractTargets({ file: TOOL_CALLS_FILE, dashboard: toolCallsDashboardJson });

    expect(targets.length).toBeGreaterThan(0);

    for (const target of targets) {
      expect(target.panelTitle.length).toBeGreaterThan(0);
      expect(target.refId.length).toBeGreaterThan(0);
      expect(target.expr.length).toBeGreaterThan(0);
      expect(target.dashboardFile).toBe(TOOL_CALLS_FILE);
      expect(target.dashboardTitle).toBe(dashboardTitle);
    }
  });
});

describe('substituteQuery', () => {
  it('expands the $__range macro to a literal duration and leaves no $ character', () => {
    const result = substituteQuery({
      expr: 'count_over_time({a="b"} [$__range])',
      variables: [],
    });

    expect(result).toContain('[1h]');
    expect(result).not.toContain('$');
  });

  it('substitutes $agent and ${project} using the real sessions templating variables', () => {
    const result = substituteQuery({
      expr: '{agent=~"$agent", project=~"${project}"}',
      variables: sessionsVariables,
    });

    expect(result).toBe('{agent=~".*", project=~".*"}');
  });

  it('expands both a macro and a variable present in the same expr', () => {
    const result = substituteQuery({
      expr: 'count_over_time({agent=~"$agent"}[$__range])',
      variables: sessionsVariables,
    });

    expect(result).toContain('1h');
    expect(result).toContain('.*');
  });

  it('leaves no $ character for every target of both committed dashboards, using each one its own templating list', () => {
    const cases: Array<{ targets: PanelTarget[]; variables: readonly TemplateVariable[] }> = [
      {
        targets: extractTargets({ file: SESSIONS_FILE, dashboard: sessionsDashboardJson }),
        variables: sessionsVariables,
      },
      {
        targets: extractTargets({ file: TOOL_CALLS_FILE, dashboard: toolCallsDashboardJson }),
        variables: toolCallsVariables,
      },
    ];

    for (const testCase of cases) {
      for (const target of testCase.targets) {
        const result = substituteQuery({ expr: target.expr, variables: testCase.variables });
        expect(result).not.toContain('$');
      }
    }
  });
});

describe('requestFor', () => {
  const endMs = 1_700_000_000_000;
  const windowMs = 3_600_000;

  it('builds a Loki instant query url against /loki/api/v1/query with a time parameter', () => {
    const target = targetFor({ datasourceType: 'loki', datasourceUid: 'loki', instant: true });
    const request = requestFor({ target, endMs, windowMs });

    expect(request.kind).toBe('loki');
    expect(request.url.startsWith('http://localhost:3100/loki/api/v1/query?')).toBe(true);

    const url = new URL(request.url);
    expect(url.searchParams.get('query')).toBe(target.expr);
    expect(url.searchParams.has('time')).toBe(true);
  });

  it('builds a Loki range query url against /loki/api/v1/query_range with start, end and a 60s step', () => {
    const target = targetFor({ datasourceType: 'loki', datasourceUid: 'loki', instant: false });
    const request = requestFor({ target, endMs, windowMs });

    expect(request.kind).toBe('loki');
    expect(request.url.startsWith('http://localhost:3100/loki/api/v1/query_range?')).toBe(true);

    const url = new URL(request.url);
    expect(url.searchParams.get('query')).toBe(target.expr);
    expect(url.searchParams.get('step')).toBe('60s');
    expect(url.searchParams.get('end')).toBe(String(endMs * 1_000_000));
    expect(url.searchParams.has('start')).toBe(true);
  });

  it('builds a Prometheus instant query url against /api/v1/query with a time parameter', () => {
    const target = targetFor({
      datasourceType: 'prometheus',
      datasourceUid: 'prometheus',
      instant: true,
    });
    const request = requestFor({ target, endMs, windowMs });

    expect(request.kind).toBe('prometheus');
    expect(request.url.startsWith('http://localhost:9090/api/v1/query?')).toBe(true);

    const url = new URL(request.url);
    expect(url.searchParams.get('query')).toBe(target.expr);
    expect(url.searchParams.has('time')).toBe(true);
  });

  it('builds a Prometheus range query url against /api/v1/query_range with a 60 second step', () => {
    const target = targetFor({
      datasourceType: 'prometheus',
      datasourceUid: 'prometheus',
      instant: false,
    });
    const request = requestFor({ target, endMs, windowMs });

    expect(request.kind).toBe('prometheus');
    expect(request.url.startsWith('http://localhost:9090/api/v1/query_range?')).toBe(true);

    const url = new URL(request.url);
    expect(url.searchParams.get('query')).toBe(target.expr);
    expect(url.searchParams.get('step')).toBe('60');
    expect(url.searchParams.get('end')).toBe(String(Math.floor(endMs / 1000)));
    expect(url.searchParams.has('start')).toBe(true);
  });

  it('gives Loki a nanosecond end and Prometheus a second end for the same endMs', () => {
    const lokiTarget = targetFor({ datasourceType: 'loki', datasourceUid: 'loki', instant: false });
    const prometheusTarget = targetFor({
      datasourceType: 'prometheus',
      datasourceUid: 'prometheus',
      instant: false,
    });

    const lokiUrl = new URL(requestFor({ target: lokiTarget, endMs, windowMs }).url);
    const prometheusUrl = new URL(requestFor({ target: prometheusTarget, endMs, windowMs }).url);

    expect(lokiUrl.searchParams.get('end')).toBe(String(endMs * 1_000_000));
    expect(prometheusUrl.searchParams.get('end')).toBe(String(Math.floor(endMs / 1000)));
  });

  it('throws for an unsupported datasourceType', () => {
    const target = targetFor({ datasourceType: 'influxdb' });

    expect(() => requestFor({ target, endMs, windowMs })).toThrow();
  });
});

describe('seriesCount', () => {
  it('returns 0 for an empty Loki vector body', () => {
    const parsed = QueryResponseSchema.parse({
      status: 'success',
      data: { resultType: 'vector', result: [] },
    });

    expect(seriesCount(parsed)).toBe(0);
  });

  it('returns 2 for a vector body holding two entries', () => {
    const parsed = QueryResponseSchema.parse({
      status: 'success',
      data: {
        resultType: 'vector',
        result: [
          { metric: { tool: 'Read' }, value: [1_762_000_000, '7'] },
          { metric: { tool: 'Read' }, value: [1_762_000_000, '7'] },
        ],
      },
    });

    expect(seriesCount(parsed)).toBe(2);
  });

  it('returns 0 for an error response', () => {
    const parsed = QueryResponseSchema.parse({ status: 'error', error: 'parse error' });

    expect(seriesCount(parsed)).toBe(0);
  });
});

describe('QueryResponseSchema', () => {
  it('rejects an empty object because status is required', () => {
    const outcome = QueryResponseSchema.safeParse({});

    expect(outcome.success).toBe(false);
  });
});

describe('formatFailureReport', () => {
  it('returns an empty string for an empty array of failures', () => {
    expect(formatFailureReport([])).toBe('');
  });

  it('includes the dashboardFile, panelTitle, refId, query and reason for each failure', () => {
    const failures: Failure[] = [
      {
        target: targetFor({ panelTitle: 'Sessions', refId: 'A' }),
        query: 'sum by (session_id) (count_over_time({service_name=~".+"} [30m]))',
        reason: 'http 500',
      },
      {
        target: targetFor({
          dashboardFile: TOOL_CALLS_FILE,
          dashboardTitle: 'Tool calls',
          panelTitle: 'Calls per tool',
          refId: 'B',
        }),
        query: 'topk(20, sum by (tool) (count_over_time({service_name=~".+"} [1h])))',
        reason: 'timeout',
      },
    ];

    const report = formatFailureReport(failures);

    for (const failure of failures) {
      expect(report).toContain(failure.target.dashboardFile);
      expect(report).toContain(failure.target.panelTitle);
      expect(report).toContain(failure.target.refId);
      expect(report).toContain(failure.query);
      expect(report).toContain(failure.reason);
    }
  });
});

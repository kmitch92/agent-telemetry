import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GridPos, PanelType } from '../src/schema/dashboard.js';
import { DashboardSchema } from '../src/schema/dashboard.js';
import { dashboard, lokiTarget, panel, renderDashboard } from '../src/dashboards/lib.js';
import { exploreActivityDashboard } from '../src/dashboards/explore-activity.js';
import { exploreLatencyDashboard } from '../src/dashboards/explore-latency.js';
import { exploreTokensDashboard } from '../src/dashboards/explore-tokens.js';
import { mcpServersDashboard } from '../src/dashboards/mcp-servers.js';
import { runsDashboard } from '../src/dashboards/runs.js';
import { sessionsDashboard } from '../src/dashboards/sessions.js';
import { toolCallsDashboard } from '../src/dashboards/tool-calls.js';

const KINDS = [
  'model_call',
  'tool_call',
  'prompt',
  'api_error',
  'mcp_server_call',
  'run_start',
  'run_end',
] as const;

function overlaps(a: GridPos, b: GridPos): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('sessionsDashboard', () => {
  it('gives every panel a non-empty description', () => {
    for (const p of sessionsDashboard.panels) {
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('names a Kind in every panel description', () => {
    for (const p of sessionsDashboard.panels) {
      expect(KINDS.some((kind) => p.description.includes(kind))).toBe(true);
    }
  });

  it('keeps the panel titles in SPEC order', () => {
    expect(sessionsDashboard.panels.map((p) => p.title)).toEqual([
      'Sessions',
      'Sessions started over time, by agent',
      'Model calls over time, by Session',
      'Input tokens per model call',
      'Output tokens per call',
      'Cache-read share of input tokens',
      'Model call latency, p50 and p95, by agent',
      'Prompts per Session',
      'Session wall-time distribution',
    ]);
  });

  it('declares the six template variables in SPEC order', () => {
    expect(sessionsDashboard.templating.list.map((v) => v.name)).toEqual([
      'agent',
      'project',
      'session_id',
      'variant',
      'task',
      'run_id',
    ]);

    for (const v of sessionsDashboard.templating.list) {
      expect(v.type).toBe('query');
      expect(v.multi).toBe(true);
      expect(v.includeAll).toBe(true);
      expect(v.allValue).toBe('.*');
      expect(v.datasource.uid).toBe('loki');
    }
  });

  it('never writes a dotted attribute name in a query', () => {
    for (const p of sessionsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).not.toMatch(/session\.id|service\.name|mcp_server\./);
      }
    }
  });

  it('anchors every stream selector', () => {
    for (const p of sessionsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).toContain('service_name=~".+"');
      }
    }
  });

  it('rejects a panel with an empty description', () => {
    expect(() => DashboardSchema.parse(sessionsDashboard)).not.toThrow();

    expect(() =>
      panel({
        id: 99,
        title: 'x',
        description: '',
        type: 'timeseries',
        gridPos: { x: 0, y: 0, w: 4, h: 4 },
        targets: [],
      }),
    ).toThrow();
  });

  it('gives every panel a unique id and a non-overlapping gridPos', () => {
    const ids = sessionsDashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const panels = sessionsDashboard.panels;
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(overlaps(a.gridPos, b.gridPos)).toBe(false);
      }
    }
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/sessions.json', 'utf8');
    expect(committed).toBe(renderDashboard(sessionsDashboard));
  });
});

describe('toolCallsDashboard', () => {
  it('gives every panel a non-empty description', () => {
    for (const p of toolCallsDashboard.panels) {
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('names a Kind in every panel description', () => {
    for (const p of toolCallsDashboard.panels) {
      expect(KINDS.some((kind) => p.description.includes(kind))).toBe(true);
    }
  });

  it('keeps the panel titles in SPEC order', () => {
    expect(toolCallsDashboard.panels.map((p) => p.title)).toEqual([
      'Calls per tool',
      'Success rate per tool',
      'Duration p50 and p95 per tool',
      'Calls by tool_type, over time',
      'Calls per mcp_server',
      'Result bytes per tool',
      'Tool calls per Session',
    ]);
  });

  it('declares the six template variables in SPEC order', () => {
    expect(toolCallsDashboard.templating.list.map((v) => v.name)).toEqual([
      'agent',
      'project',
      'session_id',
      'variant',
      'task',
      'run_id',
    ]);

    for (const v of toolCallsDashboard.templating.list) {
      expect(v.type).toBe('query');
      expect(v.multi).toBe(true);
      expect(v.includeAll).toBe(true);
      expect(v.allValue).toBe('.*');
      expect(v.datasource.uid).toBe('loki');
    }
  });

  it('never writes a dotted attribute name in a query', () => {
    for (const p of toolCallsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).not.toMatch(/session\.id|service\.name|mcp_server\./);
      }
    }
  });

  it('anchors every stream selector', () => {
    for (const p of toolCallsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).toContain('service_name=~".+"');
      }
    }
  });

  it('reads kind=tool_call in every panel', () => {
    for (const p of toolCallsDashboard.panels) {
      expect(p.targets.some((target) => target.expr.includes('kind="tool_call"'))).toBe(true);
    }
  });

  it('splits mcp against native in the tool_type panel', () => {
    const found = toolCallsDashboard.panels.find(
      (p) => p.title === 'Calls by tool_type, over time',
    );
    expect(found).toBeDefined();
    if (found === undefined) {
      throw new Error('panel not found');
    }

    expect(
      found.targets.some(
        (target) =>
          target.expr.includes('sum by (tool_type)') && target.legendFormat === '{{tool_type}}',
      ),
    ).toBe(true);
  });

  it('gives every panel a unique id and a non-overlapping gridPos', () => {
    const ids = toolCallsDashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const panels = toolCallsDashboard.panels;
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(overlaps(a.gridPos, b.gridPos)).toBe(false);
      }
    }
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/tool-calls.json', 'utf8');
    expect(committed).toBe(renderDashboard(toolCallsDashboard));
  });
});

describe('mcpServersDashboard', () => {
  it('gives every panel a non-empty description', () => {
    for (const p of mcpServersDashboard.panels) {
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('names a Kind in every panel description', () => {
    for (const p of mcpServersDashboard.panels) {
      expect(KINDS.some((kind) => p.description.includes(kind))).toBe(true);
    }
  });

  it('keeps the panel titles in SPEC order', () => {
    expect(mcpServersDashboard.panels.map((p) => p.title)).toEqual([
      'mcp_server_call rate, per server',
      'Total, internal and upstream milliseconds, p50 and p95, per server',
      'Cache hit ratio per server',
      'Target distribution, top 10',
      'Raw bytes against returned bytes, totals and ratio',
      'Errors by error type',
      'Calls per Session',
    ]);
  });

  it('declares the six template variables in SPEC order', () => {
    expect(mcpServersDashboard.templating.list.map((v) => v.name)).toEqual([
      'agent',
      'project',
      'session_id',
      'variant',
      'task',
      'run_id',
    ]);

    for (const v of mcpServersDashboard.templating.list) {
      expect(v.type).toBe('query');
      expect(v.multi).toBe(true);
      expect(v.includeAll).toBe(true);
      expect(v.allValue).toBe('.*');
      expect(v.datasource.uid).toBe('loki');
    }
  });

  it('never writes a dotted attribute name in a query', () => {
    for (const p of mcpServersDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).not.toMatch(/session\.id|service\.name|mcp_server\./);
      }
    }
  });

  it('anchors every stream selector', () => {
    for (const p of mcpServersDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).toContain('service_name=~".+"');
      }
    }
  });

  it('reads kind=mcp_server_call in every panel', () => {
    for (const p of mcpServersDashboard.panels) {
      expect(p.targets.some((target) => target.expr.includes('kind="mcp_server_call"'))).toBe(true);
    }
  });

  it('groups the per-server panels by service_name', () => {
    const titles = [
      'mcp_server_call rate, per server',
      'Total, internal and upstream milliseconds, p50 and p95, per server',
      'Cache hit ratio per server',
      'Raw bytes against returned bytes, totals and ratio',
    ];

    for (const title of titles) {
      const found = mcpServersDashboard.panels.find((p) => p.title === title);
      expect(found).toBeDefined();
      if (found === undefined) {
        throw new Error('panel not found');
      }

      expect(found.targets.some((target) => target.expr.includes('service_name'))).toBe(true);
    }
  });

  it('divides cache hits by every call that reports a cache state', () => {
    const found = mcpServersDashboard.panels.find((p) => p.title === 'Cache hit ratio per server');
    expect(found).toBeDefined();
    if (found === undefined) {
      throw new Error('panel not found');
    }

    const matching = found.targets.filter(
      (target) =>
        target.expr.includes('mcp_server_cache="hit"') &&
        target.expr.includes('mcp_server_cache!=""'),
    );
    expect(matching.length).toBe(1);

    const match = matching[0];
    expect(match).toBeDefined();
    if (match === undefined) {
      throw new Error('target not found');
    }

    expect(match.expr).toContain('/');
  });

  it('gives every panel a unique id and a non-overlapping gridPos', () => {
    const ids = mcpServersDashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const panels = mcpServersDashboard.panels;
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(overlaps(a.gridPos, b.gridPos)).toBe(false);
      }
    }
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/mcp-servers.json', 'utf8');
    expect(committed).toBe(renderDashboard(mcpServersDashboard));
  });
});

describe('runsDashboard', () => {
  it('gives every panel a non-empty description', () => {
    for (const p of runsDashboard.panels) {
      expect(p.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('names a Kind in every panel description', () => {
    for (const p of runsDashboard.panels) {
      expect(KINDS.some((kind) => p.description.includes(kind))).toBe(true);
    }
  });

  it('keeps the panel titles in SPEC order', () => {
    expect(runsDashboard.panels.map((p) => p.title)).toEqual([
      'Pass rate by variant',
      'Pass rate per task and variant',
      'Turns per Run, by variant',
      'Wall time per Run, by variant',
      'Input tokens per Run, by variant',
      'Tool calls per Run, by variant',
      'Timed-out Runs',
      'Run end Events',
    ]);
  });

  it('declares the six template variables in SPEC order', () => {
    expect(runsDashboard.templating.list.map((v) => v.name)).toEqual([
      'agent',
      'project',
      'session_id',
      'variant',
      'task',
      'run_id',
    ]);

    for (const v of runsDashboard.templating.list) {
      expect(v.type).toBe('query');
      expect(v.multi).toBe(true);
      expect(v.includeAll).toBe(true);
      expect(v.allValue).toBe('.*');
      expect(v.datasource.uid).toBe('loki');
    }
  });

  it('never writes a dotted attribute name in a query', () => {
    for (const p of runsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).not.toMatch(/session\.id|service\.name|mcp_server\./);
      }
    }
  });

  it('anchors every stream selector', () => {
    for (const p of runsDashboard.panels) {
      for (const target of p.targets) {
        expect(target.expr).toContain('service_name=~".+"');
      }
    }
  });

  it('reads kind=run_end in every panel', () => {
    for (const p of runsDashboard.panels) {
      expect(p.targets.some((target) => target.expr.includes('kind="run_end"'))).toBe(true);
    }
  });

  it('turns a boolean pass or timed_out attribute into a 0/1 series for the rate and timed-out panels', () => {
    const titles = ['Pass rate by variant', 'Pass rate per task and variant', 'Timed-out Runs'];

    for (const title of titles) {
      const found = runsDashboard.panels.find((p) => p.title === title);
      expect(found).toBeDefined();
      if (found === undefined) {
        throw new Error('panel not found');
      }

      expect(
        found.targets.some((target) => target.expr.includes(' or ') && target.expr.includes('* 0')),
      ).toBe(true);
    }
  });

  it('gives every panel a unique id and a non-overlapping gridPos', () => {
    const ids = runsDashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);

    const panels = runsDashboard.panels;
    for (let i = 0; i < panels.length; i += 1) {
      for (let j = i + 1; j < panels.length; j += 1) {
        const a = panels[i];
        const b = panels[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(overlaps(a.gridPos, b.gridPos)).toBe(false);
      }
    }
  });

  it('rejects a panel with an empty description', () => {
    expect(() => DashboardSchema.parse(runsDashboard)).not.toThrow();
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/runs.json', 'utf8');
    expect(committed).toBe(renderDashboard(runsDashboard));
  });
});

describe('exploreLatencyDashboard', () => {
  it('validates against DashboardSchema', () => {
    expect(() => DashboardSchema.parse(exploreLatencyDashboard)).not.toThrow();
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/explore-latency.json', 'utf8');
    expect(committed).toBe(renderDashboard(exploreLatencyDashboard));
  });
});

describe('exploreTokensDashboard', () => {
  it('validates against DashboardSchema', () => {
    expect(() => DashboardSchema.parse(exploreTokensDashboard)).not.toThrow();
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/explore-tokens.json', 'utf8');
    expect(committed).toBe(renderDashboard(exploreTokensDashboard));
  });
});

describe('exploreActivityDashboard', () => {
  it('validates against DashboardSchema', () => {
    expect(() => DashboardSchema.parse(exploreActivityDashboard)).not.toThrow();
  });

  it('matches the committed dashboard JSON', () => {
    const committed = readFileSync('compose/grafana/dashboards/explore-activity.json', 'utf8');
    expect(committed).toBe(renderDashboard(exploreActivityDashboard));
  });
});

/**
 * The exploratory-panel types the next phase's workers need, beyond the
 * six the four committed dashboards already use. Each panel is minimal:
 * one target, no `custom` or `options`, so the test proves the schema
 * accepts the `type` value itself rather than any particular field combo.
 */
const NEW_PANEL_TYPES: PanelType[] = [
  'heatmap',
  'gauge',
  'piechart',
  'xychart',
  'state-timeline',
  'trend',
];

describe('panel types the exploratory dashboards need', () => {
  it.each(NEW_PANEL_TYPES)('validates a minimal %s panel against DashboardSchema', (type) => {
    const minimalPanel = panel({
      id: 1,
      title: `Minimal ${type} panel`,
      description: `A minimal ${type} panel used only to prove the schema accepts this type.`,
      type,
      gridPos: { x: 0, y: 0, w: 12, h: 8 },
      targets: [lokiTarget({ refId: 'A', expr: '{service_name=~".+"}' })],
    });

    const minimalDashboard = dashboard({
      uid: `test-${type}`,
      title: `Test ${type}`,
      variables: [],
      panels: [minimalPanel],
    });

    expect(() => DashboardSchema.parse(minimalDashboard)).not.toThrow();
    expect(minimalPanel.type).toBe(type);
  });
});

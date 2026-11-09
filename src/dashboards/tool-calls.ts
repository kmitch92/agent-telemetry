import type { Dashboard } from '../schema/dashboard.js';
import { dashboard, labelVariable, lokiTarget, panel, selector } from './lib.js';

/**
 * The Tool calls dashboard (SPEC.md's dashboards section): seven panels over
 * kind=tool_call Events, all built from the shared selector in `./lib.ts` so
 * no panel ever hand-writes a stream selector.
 */

const SHARED_TIMESERIES_OPTIONS = {
  legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] },
  tooltip: { mode: 'multi', sort: 'desc' },
};

const SHARED_LINE_STYLE = {
  drawStyle: 'line',
  lineWidth: 1,
  fillOpacity: 10,
  showPoints: 'auto',
  pointSize: 5,
  barAlignment: 0,
  axisPlacement: 'auto',
  spanNulls: false,
};

const variables = [
  labelVariable({ name: 'agent', label: 'Agent' }),
  labelVariable({ name: 'project', label: 'Project' }),
  labelVariable({ name: 'session_id', label: 'Session' }),
  labelVariable({ name: 'variant', label: 'Variant' }),
  labelVariable({ name: 'task', label: 'Task' }),
  labelVariable({ name: 'run_id', label: 'Run' }),
];

const callsPerToolPanel = panel({
  id: 1,
  type: 'barchart',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  title: 'Calls per tool',
  description:
    'Shows the top 20 tools by call count over the selected range, counting kind=tool_call Events grouped by the tool attribute.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{tool}}',
      expr: `topk(20, sum by (tool) (count_over_time(${selector('tool_call')} [$__range])))`,
    }),
  ],
  custom: { lineWidth: 1, fillOpacity: 80, gradientMode: 'none', axisPlacement: 'auto' },
  options: {
    orientation: 'horizontal',
    showValue: 'auto',
    stacking: 'none',
    xTickLabelRotation: 0,
    xTickLabelSpacing: 0,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
    tooltip: { mode: 'single', sort: 'none' },
  },
  unit: 'short',
});

const successRatePanel = panel({
  id: 2,
  type: 'bargauge',
  gridPos: { x: 12, y: 0, w: 12, h: 8 },
  title: 'Success rate per tool',
  description:
    'Divides the kind=tool_call Events whose success attribute is true by all kind=tool_call Events, one bar per tool.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (count_over_time(${selector('tool_call')} | success="true" [$__range])) / sum by (tool) (count_over_time(${selector('tool_call')} [$__range]))`,
    }),
  ],
  unit: 'percentunit',
  decimals: 3,
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
    orientation: 'horizontal',
    displayMode: 'gradient',
    showUnfilled: true,
    minVizHeight: 16,
    minVizWidth: 8,
    valueMode: 'color',
    namePlacement: 'auto',
    sizing: 'auto',
  },
});

const durationPanel = panel({
  id: 3,
  type: 'timeseries',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Duration p50 and p95 per tool',
  description:
    'Reads duration_ms on kind=tool_call Events, the 50th and 95th percentile duration per tool. The Claude Code Transcript parser omits duration_ms when it cannot pair a tool result with its tool use, so a tool with no timing is absent from this panel.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 {{tool}}',
      expr: `quantile_over_time(0.5, ${selector('tool_call')} | unwrap duration_ms [$__interval]) by (tool)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p95 {{tool}}',
      expr: `quantile_over_time(0.95, ${selector('tool_call')} | unwrap duration_ms [$__interval]) by (tool)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const toolTypePanel = panel({
  id: 4,
  type: 'timeseries',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Calls by tool_type, over time',
  description:
    'Reads tool_type on kind=tool_call Events, which the Normaliser sets to mcp when the tool name begins with mcp__ and to native otherwise, counted over time.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{tool_type}}',
      expr: `sum by (tool_type) (count_over_time(${selector('tool_call')} [$__interval]))`,
    }),
  ],
  custom: {
    drawStyle: 'bars',
    lineWidth: 1,
    fillOpacity: 60,
    barAlignment: 0,
    axisPlacement: 'auto',
    showPoints: 'never',
    spanNulls: false,
    stacking: { mode: 'normal', group: 'A' },
  },
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const mcpServerPanel = panel({
  id: 5,
  type: 'bargauge',
  gridPos: { x: 0, y: 16, w: 12, h: 8 },
  title: 'Calls per mcp_server',
  description:
    'Reads mcp_server on kind=tool_call Events, which the Normaliser derives from the tool name, and the query filters to tool_type="mcp" so a native tool call never appears as an empty server.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{mcp_server}}',
      expr: `sum by (mcp_server) (count_over_time(${selector('tool_call')} | tool_type="mcp" [$__range]))`,
    }),
  ],
  unit: 'short',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
    orientation: 'horizontal',
    displayMode: 'gradient',
    showUnfilled: true,
    minVizHeight: 16,
    minVizWidth: 8,
    valueMode: 'color',
    namePlacement: 'auto',
    sizing: 'auto',
  },
});

const resultBytesPanel = panel({
  id: 6,
  type: 'barchart',
  gridPos: { x: 12, y: 16, w: 12, h: 8 },
  title: 'Result bytes per tool',
  description:
    'Reads result_bytes on kind=tool_call Events, summed per tool over the selected range, and skips an Event where that attribute is absent.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (sum_over_time(${selector('tool_call')} | result_bytes != "" | unwrap result_bytes [$__range]))`,
    }),
  ],
  custom: { lineWidth: 1, fillOpacity: 80, gradientMode: 'none', axisPlacement: 'auto' },
  options: {
    orientation: 'horizontal',
    showValue: 'auto',
    stacking: 'none',
    xTickLabelRotation: 0,
    xTickLabelSpacing: 0,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
    tooltip: { mode: 'single', sort: 'none' },
  },
  unit: 'bytes',
});

const toolCallsPerSessionPanel = panel({
  id: 7,
  type: 'bargauge',
  gridPos: { x: 0, y: 24, w: 24, h: 8 },
  title: 'Tool calls per Session',
  description:
    'Counts kind=tool_call Events per Session over the selected range, one bar per session_id.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${selector('tool_call')} [$__range]))`,
    }),
  ],
  unit: 'short',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
    orientation: 'horizontal',
    displayMode: 'gradient',
    showUnfilled: true,
    minVizHeight: 16,
    minVizWidth: 8,
    valueMode: 'color',
    namePlacement: 'auto',
    sizing: 'auto',
  },
});

export const toolCallsDashboard: Dashboard = dashboard({
  uid: 'tool-calls',
  title: 'Tool calls',
  variables,
  panels: [
    callsPerToolPanel,
    successRatePanel,
    durationPanel,
    toolTypePanel,
    mcpServerPanel,
    resultBytesPanel,
    toolCallsPerSessionPanel,
  ],
});

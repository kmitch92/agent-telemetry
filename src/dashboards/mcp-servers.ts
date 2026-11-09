import type { Dashboard } from '../schema/dashboard.js';
import { dashboard, labelVariable, lokiTarget, panel, selector } from './lib.js';

/**
 * The MCP Servers dashboard (SPEC.md's dashboards section): seven panels over
 * kind=mcp_server_call Events, all built from the shared selector in
 * `./lib.ts` so no panel ever hand-writes a stream selector.
 */

const SEL = selector('mcp_server_call');

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

const ratePerServerPanel = panel({
  id: 1,
  type: 'timeseries',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  title: 'mcp_server_call rate, per server',
  description:
    'Shows the per-second rate of kind=mcp_server_call Events, one line per service_name.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{service_name}}',
      expr: `sum by (service_name) (rate(${SEL} [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'reqps',
});

const durationPanel = panel({
  id: 2,
  type: 'timeseries',
  gridPos: { x: 12, y: 0, w: 12, h: 8 },
  title: 'Total, internal and upstream milliseconds, p50 and p95, per server',
  description:
    'Reads total_ms, internal_ms and upstream_ms on kind=mcp_server_call Events, the 50th and ' +
    '95th percentile per server. mcp_server.total_ms is a MUST attribute, so every server ' +
    'appears in the total series, while mcp_server.internal_ms and mcp_server.upstream_ms are ' +
    'SHOULD attributes, so a server that omits them is absent from those series.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 total {{service_name}}',
      expr: `quantile_over_time(0.5, ${SEL} | unwrap mcp_server_total_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p95 total {{service_name}}',
      expr: `quantile_over_time(0.95, ${SEL} | unwrap mcp_server_total_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'C',
      legendFormat: 'p50 internal {{service_name}}',
      expr: `quantile_over_time(0.5, ${SEL} | mcp_server_internal_ms != "" | unwrap mcp_server_internal_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'D',
      legendFormat: 'p95 internal {{service_name}}',
      expr: `quantile_over_time(0.95, ${SEL} | mcp_server_internal_ms != "" | unwrap mcp_server_internal_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'E',
      legendFormat: 'p50 upstream {{service_name}}',
      expr: `quantile_over_time(0.5, ${SEL} | mcp_server_upstream_ms != "" | unwrap mcp_server_upstream_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'F',
      legendFormat: 'p95 upstream {{service_name}}',
      expr: `quantile_over_time(0.95, ${SEL} | mcp_server_upstream_ms != "" | unwrap mcp_server_upstream_ms [$__interval]) by (service_name)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const cacheHitRatioPanel = panel({
  id: 3,
  type: 'bargauge',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Cache hit ratio per server',
  description:
    'Divides the kind=mcp_server_call Events whose cache attribute is hit by all ' +
    'kind=mcp_server_call Events that report a cache state, one bar per service_name. The ' +
    'denominator counts only an Event that reports a cache state, because mcp_server.cache is ' +
    'a SHOULD attribute.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{service_name}}',
      expr: `sum by (service_name) (count_over_time(${SEL} | mcp_server_cache="hit" [$__range])) / sum by (service_name) (count_over_time(${SEL} | mcp_server_cache!="" [$__range]))`,
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

const targetDistributionPanel = panel({
  id: 4,
  type: 'barchart',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Target distribution, top 10',
  description:
    'Shows the top 10 targets by call count over the selected range, counting ' +
    'kind=mcp_server_call Events grouped by the mcp_server.target attribute.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{mcp_server_target}}',
      expr: `topk(10, sum by (mcp_server_target) (count_over_time(${SEL} | mcp_server_target != "" [$__range])))`,
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

const bytesPanel = panel({
  id: 5,
  type: 'stat',
  gridPos: { x: 0, y: 16, w: 12, h: 8 },
  title: 'Raw bytes against returned bytes, totals and ratio',
  description:
    'Sums mcp_server.raw_bytes and mcp_server.returned_bytes on kind=mcp_server_call Events ' +
    'over the selected range, and divides the returned total by the raw total. The ratio reads ' +
    'NaN when every mcp_server_call Event reports zero raw bytes, which happens when the ' +
    'server made no upstream request.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: 'raw bytes',
      expr: `sum(sum_over_time(${SEL} | mcp_server_raw_bytes != "" | unwrap mcp_server_raw_bytes [$__range]))`,
    }),
    lokiTarget({
      refId: 'B',
      instant: true,
      legendFormat: 'returned bytes',
      expr: `sum(sum_over_time(${SEL} | mcp_server_returned_bytes != "" | unwrap mcp_server_returned_bytes [$__range]))`,
    }),
    lokiTarget({
      refId: 'C',
      instant: true,
      legendFormat: 'returned over raw',
      expr: `sum(sum_over_time(${SEL} | mcp_server_returned_bytes != "" | unwrap mcp_server_returned_bytes [$__range])) / sum(sum_over_time(${SEL} | mcp_server_raw_bytes != "" | unwrap mcp_server_raw_bytes [$__range]))`,
    }),
  ],
  unit: 'bytes',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'horizontal',
    textMode: 'value_and_name',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
    wideLayout: true,
    showPercentChange: false,
    percentChangeColorMode: 'standard',
  },
  overrides: [
    {
      matcher: { id: 'byFrameRefID', options: 'A' },
      properties: [{ id: 'displayName', value: 'raw bytes' }],
    },
    {
      matcher: { id: 'byFrameRefID', options: 'B' },
      properties: [{ id: 'displayName', value: 'returned bytes' }],
    },
    {
      matcher: { id: 'byFrameRefID', options: 'C' },
      properties: [{ id: 'displayName', value: 'returned over raw' }],
    },
    {
      matcher: { id: 'byFrameRefID', options: 'C' },
      properties: [{ id: 'unit', value: 'percentunit' }],
    },
  ],
});

const errorsByTypePanel = panel({
  id: 6,
  type: 'bargauge',
  gridPos: { x: 12, y: 16, w: 12, h: 8 },
  title: 'Errors by error type',
  description:
    'Reads mcp_server.error.type on kind=mcp_server_call Events whose status attribute is ' +
    'error, counted over the selected range, one bar per error type.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{mcp_server_error_type}}',
      expr: `sum by (mcp_server_error_type) (count_over_time(${SEL} | mcp_server_status="error" [$__range]))`,
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

const callsPerSessionPanel = panel({
  id: 7,
  type: 'bargauge',
  gridPos: { x: 0, y: 24, w: 24, h: 8 },
  title: 'Calls per Session',
  description:
    'Counts kind=mcp_server_call Events per Session over the selected range, one bar per ' +
    'session_id.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${SEL} [$__range]))`,
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

export const mcpServersDashboard: Dashboard = dashboard({
  uid: 'mcp-servers',
  title: 'MCP Servers',
  variables,
  panels: [
    ratePerServerPanel,
    durationPanel,
    cacheHitRatioPanel,
    targetDistributionPanel,
    bytesPanel,
    errorsByTypePanel,
    callsPerSessionPanel,
  ],
});

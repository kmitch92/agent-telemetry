import type { Dashboard } from '../schema/dashboard.js';
import { dashboard, instantLokiTarget, labelVariable, lokiTarget, panel, selector } from './lib.js';

/**
 * The exploratory "Explore: activity and runs" dashboard. Eighteen panels
 * across five themes (volume, health, sessions, runs, bytes), favouring a
 * variety of Grafana panel types over any particular polish, so the user
 * can review the set and keep the ones that earn a place on a committed
 * dashboard. Every panel is built from the shared selector in `./lib.ts`
 * so no panel ever hand-writes a stream selector.
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

const STACKED_BAR_STYLE = {
  drawStyle: 'bars',
  lineWidth: 1,
  fillOpacity: 60,
  barAlignment: 0,
  axisPlacement: 'auto',
  showPoints: 'never',
  spanNulls: false,
  stacking: { mode: 'normal', group: 'A' },
};

const HORIZONTAL_BARCHART_CUSTOM = {
  lineWidth: 1,
  fillOpacity: 80,
  gradientMode: 'none',
  axisPlacement: 'auto',
};

const HORIZONTAL_BARCHART_OPTIONS = {
  orientation: 'horizontal',
  showValue: 'auto',
  stacking: 'none',
  xTickLabelRotation: 0,
  xTickLabelSpacing: 0,
  legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  tooltip: { mode: 'single', sort: 'none' },
};

const GAUGE_OPTIONS = {
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  showThresholdLabels: false,
  showThresholdMarkers: true,
};

const STAT_OPTIONS = {
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode: 'value',
  graphMode: 'none',
  justifyMode: 'auto',
};

const variables = [
  labelVariable({ name: 'agent', label: 'Agent' }),
  labelVariable({ name: 'project', label: 'Project' }),
  labelVariable({ name: 'session_id', label: 'Session' }),
  labelVariable({ name: 'variant', label: 'Variant' }),
  labelVariable({ name: 'task', label: 'Task' }),
  labelVariable({ name: 'run_id', label: 'Run' }),
];

// --- Volume --------------------------------------------------------------

const allKindsOverTimePanel = panel({
  id: 1,
  type: 'timeseries',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  title: 'Every kind, over time',
  description:
    'Stacks the count of every Event over time, one series per kind, including a record that ' +
    'reached no kind. A label_format step renames an empty kind to the literal "none" before ' +
    'grouping, because an empty kind interpolates to an empty legend name, and Grafana then ' +
    'falls back to the raw field name "Value" instead of a readable series name, so the shape ' +
    'of a session is visible with every series legible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{kind}}',
      expr: `sum by (kind) (count_over_time(${selector()} | label_format kind=\`{{ if .kind }}{{ .kind }}{{ else }}none{{ end }}\` [$__interval]))`,
    }),
  ],
  custom: STACKED_BAR_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const modelCallsPerMinutePanel = panel({
  id: 2,
  type: 'timeseries',
  gridPos: { x: 12, y: 0, w: 12, h: 8 },
  title: 'Model calls per minute',
  description: 'Counts kind=model_call Events in fixed one-minute buckets, over time.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'model calls',
      expr: `sum(count_over_time(${selector('model_call')} [1m]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const toolCallsPerMinutePanel = panel({
  id: 3,
  type: 'timeseries',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Tool calls per minute, by tool',
  description:
    'Stacks kind=tool_call Events in fixed one-minute buckets, one series per tool attribute.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (count_over_time(${selector('tool_call')} [1m]))`,
    }),
  ],
  custom: STACKED_BAR_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const callsPerToolPanel = panel({
  id: 4,
  type: 'barchart',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Calls per tool, top 20',
  description:
    'Shows the top 20 tools by call count over the selected range, counting kind=tool_call ' +
    'Events grouped by the tool attribute, as a horizontal bar chart.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `topk(20, sum by (tool) (count_over_time(${selector('tool_call')} [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

const toolTypeSplitPanel = panel({
  id: 5,
  type: 'piechart',
  gridPos: { x: 0, y: 16, w: 12, h: 8 },
  title: 'Tool calls by tool_type, mcp against native',
  description:
    'Reads tool_type on kind=tool_call Events over the selected range, split between mcp and ' +
    'native. A reduceOptions block (every other single-value panel in this module already ' +
    'carries one) tells the piechart how to collapse each tool_type series to one slice value. ' +
    'reduceOptions.values is true, not false: an instant Loki query returns one table-shaped ' +
    'frame with tool_type as a string column and Value as the numeric column, one row per ' +
    'series, so the panel needs one slice per ROW, not one slice for the whole numeric column. ' +
    'With values: false the piechart drew a single whole slice named "Value #A" instead of one ' +
    'slice per tool_type.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool_type}}',
      expr: `sum by (tool_type) (count_over_time(${selector('tool_call')} [$__range]))`,
    }),
  ],
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
    pieType: 'pie',
    displayLabels: ['name', 'percent'],
    legend: { showLegend: true, displayMode: 'list', placement: 'right', calcs: [] },
    tooltip: { mode: 'single', sort: 'none' },
  },
  unit: 'short',
});

// --- Health ----------------------------------------------------------------

const successRateGaugePanel = panel({
  id: 6,
  type: 'gauge',
  gridPos: { x: 12, y: 16, w: 12, h: 8 },
  title: 'Tool call success rate',
  description:
    'Divides the kind=tool_call Events whose success attribute is true by all kind=tool_call ' +
    'Events over the selected range, as a percentage.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: 'success rate',
      expr: `100 * sum(count_over_time(${selector('tool_call')} | success="true" [$__range])) / sum(count_over_time(${selector('tool_call')} [$__range]))`,
    }),
  ],
  unit: 'percent',
  decimals: 1,
  thresholds: {
    mode: 'absolute',
    steps: [
      { color: 'red', value: null },
      { color: 'yellow', value: 80 },
      { color: 'green', value: 95 },
    ],
  },
  colorMode: 'thresholds',
  options: GAUGE_OPTIONS,
});

const failedToolCallsOverTimePanel = panel({
  id: 7,
  type: 'timeseries',
  gridPos: { x: 0, y: 24, w: 12, h: 8 },
  title: 'Failed tool calls, over time',
  description:
    'Counts kind=tool_call Events whose success attribute is false, over time, one series per ' +
    'tool.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (count_over_time(${selector('tool_call')} | success="false" [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const mcpErrorTypePanel = panel({
  id: 8,
  type: 'barchart',
  gridPos: { x: 12, y: 24, w: 12, h: 8 },
  title: 'MCP server errors, by error type',
  description:
    'Reads mcp_server.error.type on kind=mcp_server_call Events whose status attribute is ' +
    'error, counted over the selected range, one bar per error type.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{mcp_server_error_type}}',
      expr: `sum by (mcp_server_error_type) (count_over_time(${selector('mcp_server_call')} | mcp_server_status="error" [$__range]))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

const mcpCacheHitRatioPanel = panel({
  id: 9,
  type: 'gauge',
  gridPos: { x: 0, y: 32, w: 12, h: 8 },
  title: 'MCP server cache hit ratio',
  description:
    'Divides the kind=mcp_server_call Events whose mcp_server.cache attribute is hit by all ' +
    'kind=mcp_server_call Events that report a cache state, over the selected range, as a ' +
    'percentage. Only 184 mcp_server_call records exist, so this gauge can read thin.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: 'cache hit ratio',
      expr: `100 * sum(count_over_time(${selector('mcp_server_call')} | mcp_server_cache="hit" [$__range])) / sum(count_over_time(${selector('mcp_server_call')} | mcp_server_cache!="" [$__range]))`,
    }),
  ],
  unit: 'percent',
  decimals: 1,
  thresholds: {
    mode: 'absolute',
    steps: [
      { color: 'red', value: null },
      { color: 'yellow', value: 50 },
      { color: 'green', value: 80 },
    ],
  },
  colorMode: 'thresholds',
  options: GAUGE_OPTIONS,
});

// --- Sessions ----------------------------------------------------------------

const activeSessionsOverTimePanel = panel({
  id: 10,
  type: 'timeseries',
  gridPos: { x: 12, y: 32, w: 12, h: 8 },
  title: 'Active sessions, over time',
  description:
    'Counts the distinct session_id values emitting any Event in each time bucket, over time.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'active sessions',
      expr: `count(count by (session_id) (count_over_time(${selector()} [$__interval])))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const sessionActivityStateTimelinePanel = panel({
  id: 11,
  type: 'state-timeline',
  gridPos: { x: 0, y: 40, w: 24, h: 24 },
  title: 'Session activity, by session',
  description:
    'Shows one row per session_id, limited to the top 20 sessions by Event count over the ' +
    'selected range, counting every Event over time, so a gap in a row shows when that session ' +
    'was not emitting. Each row is labelled by the first 8 characters of session_id, because ' +
    'the full 36-character identifier overlaps and becomes unreadable as a row label. The ' +
    'panel is 24 grid rows tall, rather than the 8 rows every other panel on this board uses, ' +
    'because twenty state-timeline rows need the extra height to stay legible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_short}}',
      expr: `topk(20, sum by (session_short) (count_over_time(${selector()} | label_format session_short=\`{{ substr 0 8 .session_id }}\` [$__interval])))`,
    }),
  ],
  custom: {},
  options: {
    mergeValues: true,
    showValue: 'auto',
    alignValue: 'left',
    rowHeight: 0.9,
    legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] },
    tooltip: { mode: 'single', sort: 'none' },
  },
  unit: 'short',
});

const modelCallsPerSessionPanel = panel({
  id: 12,
  type: 'barchart',
  gridPos: { x: 0, y: 64, w: 12, h: 8 },
  title: 'Model calls per session, top 20',
  description:
    'Shows the top 20 session_id values by model call count over the selected range, counting ' +
    'kind=model_call Events, as a horizontal bar chart. Each bar is labelled by the first 8 ' +
    'characters of session_id, because the full 36-character identifier overlaps and becomes ' +
    'unreadable on the category axis.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_short}}',
      expr: `topk(20, sum by (session_short) (count_over_time(${selector('model_call')} | label_format session_short=\`{{ substr 0 8 .session_id }}\` [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

// --- Runs --------------------------------------------------------------------

const runPassRatePanel = panel({
  id: 13,
  type: 'stat',
  gridPos: { x: 12, y: 64, w: 12, h: 8 },
  title: 'Run pass rate',
  description:
    'Divides the kind=run_end Events whose pass attribute is true by all kind=run_end Events ' +
    'over the selected range, expressed as a fraction from 0 to 1 under the percentunit unit, ' +
    'so Grafana renders it as a percentage. The query no longer multiplies by 100 itself: that ' +
    'extra multiplication produced a figure like 1.4 under the unrelated unit=short, which ' +
    'reads as neither a 0-to-1 proportion nor a clearly labelled percentage. The `or (... * 0)` ' +
    'term reports a true zero when no Event in range has pass="true", and no Event is ' +
    'fabricated. Only 304 run_end records exist, so this stat can read thin.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: 'pass rate',
      expr: `(sum(count_over_time(${selector('run_end')} | pass="true" [$__range])) or (sum(count_over_time(${selector('run_end')} [$__range])) * 0)) / sum(count_over_time(${selector('run_end')} [$__range]))`,
    }),
  ],
  unit: 'percentunit',
  decimals: 1,
  options: STAT_OPTIONS,
});

const wallMsPerRunPanel = panel({
  id: 14,
  type: 'barchart',
  gridPos: { x: 0, y: 72, w: 12, h: 8 },
  title: 'Wall time per run',
  description:
    'Reads wall_ms on kind=run_end Events over the selected range, the top 20 runs by wall ' +
    'time, one bar per run_id. Each bar is labelled by the first 8 characters of run_id with ' +
    'the replay- or conform- prefix stripped first, because the full identifier overlaps and ' +
    'becomes unreadable on the category axis, and because every replayed run_id shares the ' +
    'literal "replay-" prefix, which would collide if truncated without stripping it first. A ' +
    'direct Loki query against this exact expression (max by run_id of max_over_time wall_ms) ' +
    'confirms the arithmetic is a true per-run maximum, not a sum: the largest bar reflects one ' +
    'genuine recorded run_end Event at wall_ms=257529602 (about 71.5 hours), not a unit or ' +
    'aggregation bug. Only 304 run_end records exist, so this chart can read thin.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{run_id_short}}',
      expr: `topk(20, max by (run_id_short) (max_over_time(${selector('run_end')} | label_format run_id_short=\`{{ trimPrefix "replay-" .run_id | trimPrefix "conform-" | substr 0 8 }}\` | unwrap wall_ms [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'ms',
});

const turnsPerRunOverTimePanel = panel({
  id: 15,
  type: 'timeseries',
  gridPos: { x: 12, y: 72, w: 12, h: 8 },
  title: 'Turns per run, over time',
  description:
    'Reads turns on kind=run_end Events, one series per run_id, over time. A run_end Event is a ' +
    'single point in time, so the lookback window is widened to a fixed 6 hours (rather than ' +
    'the panel-width-dependent $__interval) to hold each point visible across several ' +
    'consecutive steps, and points are drawn large and always-on rather than left to the ' +
    'default auto visibility, so an isolated run_end Event is still legible. Each series is ' +
    'labelled by the first 8 characters of run_id with the replay- or conform- prefix stripped ' +
    'first, because the full identifier overlaps and fills a third of the panel as a legend. ' +
    'Only 304 run_end records exist, so this chart can read thin.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{run_id_short}}',
      expr: `max by (run_id_short) (max_over_time(${selector('run_end')} | label_format run_id_short=\`{{ trimPrefix "replay-" .run_id | trimPrefix "conform-" | substr 0 8 }}\` | unwrap turns [6h]))`,
    }),
  ],
  custom: { ...SHARED_LINE_STYLE, showPoints: 'always', pointSize: 8, lineWidth: 2 },
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const timedOutRunsPanel = panel({
  id: 16,
  type: 'stat',
  gridPos: { x: 0, y: 80, w: 12, h: 8 },
  title: 'Timed-out runs',
  description:
    'Counts kind=run_end Events whose timed_out attribute is true, over the selected range. ' +
    'The `or (... * 0)` term reports a true zero when no Event in range has timed_out="true", ' +
    'and no Event is fabricated. Only 304 run_end records exist, so this stat can read thin.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: 'timed out',
      expr: `sum(count_over_time(${selector('run_end')} | timed_out="true" [$__range])) or (sum(count_over_time(${selector('run_end')} [$__range])) * 0)`,
    }),
  ],
  unit: 'short',
  thresholds: {
    mode: 'absolute',
    steps: [
      { color: 'green', value: null },
      { color: 'red', value: 1 },
    ],
  },
  colorMode: 'thresholds',
  options: STAT_OPTIONS,
});

// --- Bytes -------------------------------------------------------------------

const mcpBytesOverTimePanel = panel({
  id: 17,
  type: 'timeseries',
  gridPos: { x: 12, y: 80, w: 12, h: 8 },
  title: 'MCP server raw bytes against returned bytes, over time',
  description:
    'Sums mcp_server.raw_bytes and mcp_server.returned_bytes on kind=mcp_server_call Events, ' +
    'over time. Only 184 mcp_server_call records exist, so this chart can read thin.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'raw bytes',
      expr: `sum(sum_over_time(${selector('mcp_server_call')} | mcp_server_raw_bytes != "" | unwrap mcp_server_raw_bytes [$__interval]))`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'returned bytes',
      expr: `sum(sum_over_time(${selector('mcp_server_call')} | mcp_server_returned_bytes != "" | unwrap mcp_server_returned_bytes [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'bytes',
});

const resultBytesPerToolPanel = panel({
  id: 18,
  type: 'barchart',
  gridPos: { x: 0, y: 88, w: 24, h: 8 },
  title: 'Result bytes per tool, top 20',
  description:
    'Sums result_bytes on kind=tool_call Events over the selected range, one named bar per ' +
    'tool, for the top 20 tools that report it. Rendered as a horizontal bar chart rather than ' +
    'a bar gauge: a bar gauge fed by this query drew a single unnamed bar whenever the result ' +
    'narrowed to one series, because a bar gauge with exactly one field hides its name label, ' +
    'while a bar chart always shows a labelled category per bar regardless of series count. ' +
    'result_bytes is present on a share of recorded kind=tool_call Events (the Claude Code ' +
    'Transcript parser sets it only when it can read tool_result_size_bytes), so a tool that ' +
    'never exposes it is absent from this panel rather than shown at zero.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `topk(20, sum by (tool) (sum_over_time(${selector('tool_call')} | result_bytes != "" | unwrap result_bytes [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'bytes',
});

export const exploreActivityDashboard: Dashboard = dashboard({
  uid: 'explore-activity',
  title: 'Explore: activity and runs',
  variables,
  // Confirmed against a live Grafana 11.6.16: the captured Events span
  // roughly one day, not a month, so "Last 7 days" compressed every chart
  // into the right-hand edge. "Last 24 hours" spreads them across the
  // full width.
  time: { from: 'now-24h', to: 'now' },
  panels: [
    allKindsOverTimePanel,
    modelCallsPerMinutePanel,
    toolCallsPerMinutePanel,
    callsPerToolPanel,
    toolTypeSplitPanel,
    successRateGaugePanel,
    failedToolCallsOverTimePanel,
    mcpErrorTypePanel,
    mcpCacheHitRatioPanel,
    activeSessionsOverTimePanel,
    sessionActivityStateTimelinePanel,
    modelCallsPerSessionPanel,
    runPassRatePanel,
    wallMsPerRunPanel,
    turnsPerRunOverTimePanel,
    timedOutRunsPanel,
    mcpBytesOverTimePanel,
    resultBytesPerToolPanel,
  ],
});

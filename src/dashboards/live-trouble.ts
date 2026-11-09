import type { Dashboard, ThresholdsConfig } from '../schema/dashboard.js';
import {
  dashboard,
  instantLokiTarget,
  labelVariable,
  liveSelector,
  lokiTarget,
  organizeTransformation,
  panel,
} from './lib.js';

/**
 * The fourth of four experimental live boards: "Live, trouble". Twelve
 * panels over errors, failures, stalls and slow calls, built from
 * `liveSelector` in `./lib.ts` so every panel honours the `session_label`
 * and `branch` live filters alongside the usual six. Defaults to the last
 * 24 hours with a 5s refresh, offering 5s and 10s in the time picker.
 * Favours breadth over polish, same as the three sibling exploratory
 * boards: the operator keeps the panels that earn a place and drops the
 * rest. No panel reads kind=api_error: the Normaliser
 * (compose/collector/config.yaml, Group B) writes no mapping to that kind,
 * so no Event carries it today.
 */

const TOOL_SEL = liveSelector('tool_call');
const MODEL_SEL = liveSelector('model_call');
const MCP_SEL = liveSelector('mcp_server_call');
const ANY_SEL = liveSelector();

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

/**
 * A live window defaults to 24 hours, so a per-interval
 * aggregation such as the p95 duration series is sparse relative to
 * `$__interval`: an interval with no model call renders a null bucket.
 * Bridging the null buckets and always drawing the point marker turns
 * that scatter of dots back into a readable line, the same fix the
 * Explore: latency board applies for the same reason.
 */
const SPARSE_LINE_STYLE = {
  ...SHARED_LINE_STYLE,
  showPoints: 'always',
  spanNulls: true,
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

/**
 * A `bargauge` fed by a query that narrows to one series hides its label
 * (lesson already paid for on the Explore boards), so every per-category
 * panel here uses a horizontal `barchart` instead, which always labels
 * every category on its axis regardless of series count.
 */
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

const TABLE_CUSTOM = {
  align: 'auto',
  cellOptions: { type: 'auto' as const },
  inspect: false,
  filterable: true,
};

const TABLE_OPTIONS = {
  showHeader: true,
  cellHeight: 'sm',
  footer: { show: false, reducer: ['sum'], countRows: false, fields: '' },
};

const FAILURE_COUNT_THRESHOLDS: ThresholdsConfig = {
  mode: 'absolute',
  steps: [
    { color: 'green', value: null },
    { color: 'red', value: 1 },
  ],
};

const MAX_DURATION_THRESHOLDS: ThresholdsConfig = {
  mode: 'absolute',
  steps: [
    { color: 'green', value: null },
    { color: 'orange', value: 10000 },
    { color: 'red', value: 30000 },
  ],
};

/**
 * Most already-stored Events have no `session_label` (it is new, only a
 * hand-started Session carrying it today), so every column or legend that
 * reads it falls back to the first 8 characters of `session_id`, the same
 * substitution `explore-activity.ts`'s state-timeline panel applies to
 * `session_id` itself. Sits after the kind and any success/duration
 * filters and before `| unwrap`, so an unwrapped field stays unaffected.
 */
const SESSION_LABEL_STAGE =
  '| label_format session_label=`{{ if .session_label }}{{ .session_label }}{{ else }}{{ substr 0 8 .session_id }}{{ end }}`';

const variables = [
  labelVariable({ name: 'agent', label: 'Agent' }),
  labelVariable({ name: 'project', label: 'Project' }),
  labelVariable({ name: 'session_id', label: 'Session' }),
  labelVariable({ name: 'variant', label: 'Variant' }),
  labelVariable({ name: 'task', label: 'Task' }),
  labelVariable({ name: 'run_id', label: 'Run' }),
  labelVariable({ name: 'session_label', label: 'Session label' }),
  labelVariable({ name: 'branch', label: 'Branch' }),
];

// --- At a glance ------------------------------------------------------------

const failedToolCallsStatPanel = panel({
  id: 1,
  type: 'stat',
  gridPos: { x: 0, y: 0, w: 6, h: 6 },
  title: 'Failed tool calls in window',
  description:
    'Counts kind=tool_call Events whose success attribute is false, over the selected time ' +
    'range (default the last 24 hours). The noValue field reads 0 instead of "No data" when ' +
    'Loki returns no matching line, so a clean window reads as a genuine zero.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(count_over_time(${TOOL_SEL} | success="false" [$__range]))`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  thresholds: FAILURE_COUNT_THRESHOLDS,
  colorMode: 'thresholds',
  options: STAT_OPTIONS,
});

const toolCallSuccessRateGaugePanel = panel({
  id: 2,
  type: 'gauge',
  gridPos: { x: 6, y: 0, w: 6, h: 6 },
  title: 'Tool call success rate',
  description:
    'Divides the kind=tool_call Events whose success attribute is true by all kind=tool_call ' +
    'Events over the selected time range, as a percentage, red below 95 percent.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: 'success rate',
      expr: `100 * sum(count_over_time(${TOOL_SEL} | success="true" [$__range])) / sum(count_over_time(${TOOL_SEL} [$__range]))`,
    }),
  ],
  unit: 'percent',
  decimals: 1,
  thresholds: {
    mode: 'absolute',
    steps: [
      { color: 'red', value: null },
      { color: 'green', value: 95 },
    ],
  },
  colorMode: 'thresholds',
  options: GAUGE_OPTIONS,
});

const slowestModelCallStatPanel = panel({
  id: 3,
  type: 'stat',
  gridPos: { x: 12, y: 0, w: 6, h: 6 },
  title: 'Slowest model call in window',
  description:
    'Reads duration_ms on kind=model_call Events, the maximum value anywhere in the selected ' +
    'time range, coloured by thresholds at 10s and 30s. noValue reads 0 when no model call ' +
    'landed in the window.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `max(max_over_time(${MODEL_SEL} | unwrap duration_ms [$__range]))`,
    }),
  ],
  unit: 'ms',
  noValue: '0',
  thresholds: MAX_DURATION_THRESHOLDS,
  colorMode: 'thresholds',
  options: STAT_OPTIONS,
});

const mcpErrorCountStatPanel = panel({
  id: 4,
  type: 'stat',
  gridPos: { x: 18, y: 0, w: 6, h: 6 },
  title: 'MCP server errors in window',
  description:
    'Counts kind=mcp_server_call Events whose mcp_server_status attribute is error, over the ' +
    'selected time range, every error type combined. noValue reads 0 instead of "No data" when ' +
    'every mcp_server_call Event in range reports no error.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(count_over_time(${MCP_SEL} | mcp_server_status="error" [$__range]))`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  thresholds: FAILURE_COUNT_THRESHOLDS,
  colorMode: 'thresholds',
  options: STAT_OPTIONS,
});

// --- Who and what is breaking ------------------------------------------------

const failuresByToolBarChartPanel = panel({
  id: 5,
  type: 'barchart',
  gridPos: { x: 0, y: 6, w: 12, h: 8 },
  title: 'Failed tool calls, by tool',
  description:
    'Counts kind=tool_call Events whose success attribute is false over the selected time ' +
    'range, one bar per tool, as a horizontal bar chart, so the tool that keeps breaking stands ' +
    'out.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (count_over_time(${TOOL_SEL} | success="false" [$__range]))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

const mcpErrorsByTypeBarChartPanel = panel({
  id: 6,
  type: 'barchart',
  gridPos: { x: 12, y: 6, w: 12, h: 8 },
  title: 'MCP server errors, by error type',
  description:
    'Reads mcp_server_error_type on kind=mcp_server_call Events whose mcp_server_status ' +
    'attribute is error, counted over the selected time range, one bar per error type, as a ' +
    'horizontal bar chart.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{mcp_server_error_type}}',
      expr: `sum by (mcp_server_error_type) (count_over_time(${MCP_SEL} | mcp_server_status="error" [$__range]))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

// --- Is it slow right now ----------------------------------------------------

const modelDurationP95Panel = panel({
  id: 7,
  type: 'timeseries',
  gridPos: { x: 0, y: 14, w: 12, h: 8 },
  title: 'Model call duration, p95, over the window',
  description:
    'Reads duration_ms on kind=model_call Events, the 95th percentile duration in each ' +
    'interval, one series per model, over the selected time range, so an API that is slowing ' +
    'down shows as a rising line. The by (model) grouping is required, not cosmetic: without ' +
    'it quantile_over_time groups by every distinct stream instead of collapsing to one series ' +
    "per model, and over a 24-hour range with many historical streams that exceeded Loki's " +
    '500-series-per-query limit. Model calls are sparse relative to $__interval in a short ' +
    'live window, so null buckets are bridged and every point is drawn.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p95 {{model}}',
      expr: `quantile_over_time(0.95, ${MODEL_SEL} | unwrap duration_ms [$__interval]) by (model)`,
    }),
  ],
  custom: SPARSE_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const failedToolCallsOverTimePanel = panel({
  id: 8,
  type: 'timeseries',
  gridPos: { x: 12, y: 14, w: 12, h: 8 },
  title: 'Failed tool calls, over time, by tool',
  description:
    'Counts kind=tool_call Events whose success attribute is false, stacked in fixed-interval ' +
    'buckets over the selected time range, one series per tool, so a burst of failures is ' +
    'visible against the quiet baseline.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `sum by (tool) (count_over_time(${TOOL_SEL} | success="false" [$__interval]))`,
    }),
  ],
  custom: STACKED_BAR_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

// --- Glance ------------------------------------------------------------------

const troubleStateTimelinePanel = panel({
  id: 9,
  type: 'state-timeline',
  gridPos: { x: 0, y: 22, w: 24, h: 6 },
  title: 'Trouble windows',
  description:
    'One row, counting kind=tool_call failures plus kind=mcp_server_call errors in each ' +
    'interval over the selected time range. Each `or (... * 0)` term reports a true zero for an ' +
    'interval that saw any Event at all but no failure of that kind, so a colored segment means ' +
    'genuine trouble, a zero segment means a quiet-but-active interval, and a gap means no ' +
    'Event at all; no Event is fabricated to fill a gap.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'failures',
      expr:
        `(sum(count_over_time(${TOOL_SEL} | success="false" [$__interval])) or ` +
        `(sum(count_over_time(${ANY_SEL} [$__interval])) * 0)) + ` +
        `(sum(count_over_time(${MCP_SEL} | mcp_server_status="error" [$__interval])) or ` +
        `(sum(count_over_time(${ANY_SEL} [$__interval])) * 0))`,
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

// --- The detail behind the numbers ------------------------------------------

const lastFailuresTablePanel = panel({
  id: 10,
  type: 'table',
  gridPos: { x: 0, y: 28, w: 24, h: 10 },
  title: 'Last 50 failures',
  description:
    'Reads kind=tool_call Events whose success attribute is false, as raw log lines, a range ' +
    'query over the selected time range. A label_format stage sets session_label to the live ' +
    'session_label when present, otherwise the first 8 characters of session_id, before the ' +
    'Extract fields transformation splits the raw labels field into one field per Event ' +
    'attribute, convertFieldType makes duration_ms numeric so it sorts correctly, and the table ' +
    'is sorted by Time descending and limited to the latest 50 rows. Columns: the call Time, ' +
    'Session label, tool name and Duration (ms, millisecond-unit override); never the arguments ' +
    'or the output, and every other Event attribute is dropped.',
  targets: [
    lokiTarget({ refId: 'A', expr: `${TOOL_SEL} | success="false" ${SESSION_LABEL_STAGE}` }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: { conversions: [{ targetField: 'duration_ms', destinationType: 'number' }] },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Time', desc: true }] } },
    { id: 'limit', options: { limitField: 50 } },
    organizeTransformation({
      order: ['Time', 'session_label', 'tool', 'duration_ms'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'agent',
        'branch',
        'project',
        'run_id',
        'task',
        'variant',
        'session_id',
        'kind',
        'success',
        'tool_type',
        'mcp_server',
        'result_bytes',
        'detected_level',
        'observed_timestamp',
        'scope_name',
        'scope_version',
        'service_name',
        'service_version',
        'severity_number',
        'severity_text',
        'host_arch',
        'os_type',
        'os_version',
        'config',
      ],
    }),
  ],
  overrides: [
    {
      matcher: { id: 'byNames', options: { mode: 'include', names: ['duration_ms'] } },
      properties: [{ id: 'unit', value: 'ms' }],
    },
  ],
});

const slowModelCallsTablePanel = panel({
  id: 11,
  type: 'table',
  gridPos: { x: 0, y: 38, w: 24, h: 10 },
  title: 'Model calls over 60 seconds',
  description:
    'Reads kind=model_call Events whose duration_ms exceeds 60000, as raw log lines, a range ' +
    'query over the selected time range. A label_format stage sets session_label to the live ' +
    'session_label when present, otherwise the first 8 characters of session_id, before the ' +
    'Extract fields transformation splits the raw labels field into one field per Event ' +
    'attribute, convertFieldType makes duration_ms numeric, and the table is sorted by Time ' +
    'descending. Columns: the call Time, Session label, model and Duration (ms, ' +
    'millisecond-unit override); never the prompt or the response, and every other Event ' +
    'attribute is dropped.',
  targets: [
    lokiTarget({ refId: 'A', expr: `${MODEL_SEL} | duration_ms > 60000 ${SESSION_LABEL_STAGE}` }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: { conversions: [{ targetField: 'duration_ms', destinationType: 'number' }] },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Time', desc: true }] } },
    organizeTransformation({
      order: ['Time', 'session_label', 'model', 'duration_ms'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'agent',
        'branch',
        'project',
        'run_id',
        'task',
        'variant',
        'session_id',
        'kind',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'reasoning_tokens',
        'cost_usd',
        'detected_level',
        'observed_timestamp',
        'scope_name',
        'scope_version',
        'service_name',
        'service_version',
        'severity_number',
        'severity_text',
        'host_arch',
        'os_type',
        'os_version',
        'config',
      ],
    }),
  ],
  overrides: [
    {
      matcher: { id: 'byNames', options: { mode: 'include', names: ['duration_ms'] } },
      properties: [{ id: 'unit', value: 'ms' }],
    },
  ],
});

// --- Stalls -------------------------------------------------------------------

const quietestActiveSessionSilencePanel = panel({
  id: 12,
  type: 'stat',
  gridPos: { x: 0, y: 48, w: 8, h: 6 },
  title: 'Quietest active Session, time silent',
  description:
    'Reads observed_timestamp on every Event over the selected time range, the latest value per ' +
    'session_id, so only a Session that emitted at least one Event in the window counts as ' +
    'active. The built-in Grafana variable $__to (the end of the selected time range, in ' +
    "Unix milliseconds) minus each Session's latest observed_timestamp (converted from " +
    "nanoseconds to milliseconds) gives that Session's silence so far; the outer max picks the " +
    'longest, catching a Session that has stalled. noValue reads 0 when no Session is active in ' +
    'the window at all.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `max($__to - (max by (session_id) (max_over_time(${ANY_SEL} | unwrap observed_timestamp [$__range])) / 1000000))`,
    }),
  ],
  unit: 'ms',
  noValue: '0',
  thresholds: {
    mode: 'absolute',
    steps: [
      { color: 'green', value: null },
      { color: 'orange', value: 120000 },
      { color: 'red', value: 300000 },
    ],
  },
  colorMode: 'thresholds',
  options: STAT_OPTIONS,
});

export const liveTroubleDashboard: Dashboard = dashboard({
  uid: 'live-trouble',
  title: 'Live, trouble',
  variables,
  time: { from: 'now-24h', to: 'now' },
  refresh: '5s',
  timepicker: { refresh_intervals: ['5s', '10s'] },
  panels: [
    failedToolCallsStatPanel,
    toolCallSuccessRateGaugePanel,
    slowestModelCallStatPanel,
    mcpErrorCountStatPanel,
    failuresByToolBarChartPanel,
    mcpErrorsByTypeBarChartPanel,
    modelDurationP95Panel,
    failedToolCallsOverTimePanel,
    troubleStateTimelinePanel,
    lastFailuresTablePanel,
    slowModelCallsTablePanel,
    quietestActiveSessionSilencePanel,
  ],
});

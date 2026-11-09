import type { Dashboard, ThresholdsConfig } from '../schema/dashboard.js';
import {
  dashboard,
  labelVariable,
  lokiTarget,
  organizeTransformation,
  panel,
  selector,
} from './lib.js';

/**
 * The Explore: latency dashboard: an exploration board over duration_ms on
 * kind=model_call and kind=tool_call Events, and the mcp_server.* latency
 * fields on kind=mcp_server_call Events. Built from the shared selector in
 * `./lib.ts`, same as every other dashboard, so no panel ever hand-writes a
 * stream selector. Favours variety of visualisation type over polish: the
 * user keeps the panels that earn a place on a permanent dashboard and
 * drops the rest.
 */

const MODEL_SEL = selector('model_call');
const TOOL_SEL = selector('tool_call');
const MCP_SEL = selector('mcp_server_call');

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
 * `bargauge` draws a single unnamed bar with a large blank area when a
 * query returns few series (fault 3): the Activity board hit the same
 * fault and fixed it by switching to a horizontal `barchart`, which always
 * labels every category on its axis, so every per-tool and per-target
 * panel on this board that used `bargauge` copies that shape instead.
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

/**
 * `SHARED_LINE_STYLE` plus `spanNulls: true` and `showPoints: 'always'`: for
 * a series whose per-interval aggregation is sparse relative to
 * `$__interval` (an interval with no Event renders a null bucket), a line
 * panel otherwise draws an isolated point per populated bucket with nothing
 * joining them. Bridging the null buckets and always drawing the point
 * marker turns that scatter of dots back into a readable line.
 */
const SPARSE_LINE_STYLE = {
  ...SHARED_LINE_STYLE,
  showPoints: 'always',
  spanNulls: true,
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

/**
 * `session_id` is a 36-character UUID, unreadable as a table column. This
 * LogQL `label_format` stage rewrites the label to its first 8 characters
 * before the Extract fields transformation parses it out of the raw
 * `labels` field, so the slowest-calls tables show a short, readable id.
 */
const SHORT_SESSION_ID_STAGE = '| label_format session_id="{{ .session_id | trunc 8 }}"';

/**
 * `trend` replaces `xychart` for a scatter of points (fault 1): the
 * xychart plugin does not load in this Grafana image, so every point-cloud
 * panel on this board draws as a `trend` panel with its line suppressed
 * and every point marker always drawn.
 */
const SCATTER_POINT_STYLE = {
  drawStyle: 'points',
  lineWidth: 0,
  fillOpacity: 0,
  showPoints: 'always',
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

/**
 * Builds a Prometheus-style cumulative bucket expression over a selector's
 * unwrapped field: one `label_replace` branch per bucket upper bound,
 * joined with `or`, each branch counting an Event whose field is below
 * that bound. Grafana's heatmap panel reads the resulting `le` label as the
 * bucket boundary, the same convention a native histogram metric uses.
 */
function cumulativeBucketExpr(sel: string, field: string, bounds: number[]): string {
  return bounds
    .map((bound) => {
      const boundText = String(bound);
      return `label_replace(sum(count_over_time(${sel} | ${field} < ${boundText} [$__interval])), "le", "${boundText}", "", "")`;
    })
    .join(' or ');
}

const MAX_DURATION_THRESHOLDS: ThresholdsConfig = {
  mode: 'absolute',
  steps: [
    { color: 'green', value: null },
    { color: 'orange', value: 10000 },
    { color: 'red', value: 30000 },
  ],
};

// --- Model call latency -----------------------------------------------

const modelDurationPercentilesPanel = panel({
  id: 1,
  type: 'timeseries',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  title: 'Model call duration, p50/p90/p99, by model',
  description:
    'Reads duration_ms on kind=model_call Events, the 50th, 90th and 99th percentile duration, one series set per model. Model calls are sparse relative to $__interval, so null buckets are bridged (spanNulls) and every point is drawn, turning what would otherwise be isolated dots into a readable line.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 {{model}}',
      expr: `quantile_over_time(0.5, ${MODEL_SEL} | unwrap duration_ms [$__interval]) by (model)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p90 {{model}}',
      expr: `quantile_over_time(0.9, ${MODEL_SEL} | unwrap duration_ms [$__interval]) by (model)`,
    }),
    lokiTarget({
      refId: 'C',
      legendFormat: 'p99 {{model}}',
      expr: `quantile_over_time(0.99, ${MODEL_SEL} | unwrap duration_ms [$__interval]) by (model)`,
    }),
  ],
  custom: SPARSE_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const modelDurationHeatmapPanel = panel({
  id: 2,
  type: 'heatmap',
  gridPos: { x: 12, y: 0, w: 12, h: 8 },
  title: 'Model call duration, distribution over time',
  description:
    'Reads duration_ms on kind=model_call Events, bucketed into cumulative "le" bands by cumulative count_over_time, so the spread of model call latency across the selected range is visible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{le}}',
      expr: cumulativeBucketExpr(
        MODEL_SEL,
        'duration_ms',
        [250, 500, 1000, 2500, 5000, 10000, 20000, 40000],
      ),
    }),
  ],
  options: {
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
  unit: 'ms',
});

const modelDurationHistogramPanel = panel({
  id: 3,
  type: 'histogram',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Model call duration, overall distribution',
  description:
    'Reads duration_ms on kind=model_call Events, the median duration per Session, one value per session_id. Loki cannot histogram a raw per-call value because duration_ms is unwrapped rather than a label, so this is the per-Session distribution, the same limitation the Sessions dashboard notes for its wall-time histogram.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_id}}',
      expr: `quantile_over_time(0.5, ${MODEL_SEL} | unwrap duration_ms [$__range]) by (session_id)`,
    }),
  ],
  custom: { fillOpacity: 80, lineWidth: 1 },
  options: {
    bucketOffset: 0,
    combine: true,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
  unit: 'ms',
});

const modelMaxDurationPanel = panel({
  id: 4,
  type: 'stat',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Maximum model call duration in range',
  description:
    'Reads duration_ms on kind=model_call Events, the maximum value anywhere in the selected range, coloured by thresholds at 10s and 30s.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      expr: `max(max_over_time(${MODEL_SEL} | unwrap duration_ms [$__range]))`,
    }),
  ],
  unit: 'ms',
  thresholds: MAX_DURATION_THRESHOLDS,
  colorMode: 'thresholds',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const slowestModelCallsPanel = panel({
  id: 5,
  type: 'table',
  gridPos: { x: 0, y: 16, w: 24, h: 10 },
  title: 'Slowest 50 model calls',
  description:
    'Reads kind=model_call Events as raw log lines, a range query over the selected range. A label_format stage shortens session_id to 8 characters before the Extract fields transformation splits the raw labels field into one field per Event attribute, convertFieldType makes duration_ms, input_tokens and output_tokens numeric so duration_ms sorts correctly, and the table is sorted by duration_ms descending and limited to the slowest 50. Columns: the call Time, model, Duration (ms, millisecond-unit override), Session, input tokens and output tokens; every other Event attribute and log field the unprocessed logs query would otherwise show is dropped.',
  targets: [lokiTarget({ refId: 'A', expr: `${MODEL_SEL} ${SHORT_SESSION_ID_STAGE}` })],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'duration_ms', destinationType: 'number' },
          { targetField: 'input_tokens', destinationType: 'number' },
          { targetField: 'output_tokens', destinationType: 'number' },
        ],
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'duration_ms', desc: true }] } },
    { id: 'limit', options: { limitField: 50 } },
    organizeTransformation({
      order: ['Time', 'model', 'duration_ms', 'session_id', 'input_tokens', 'output_tokens'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'agent',
        'cache_read_tokens',
        'cache_write_tokens',
        'detected_level',
        'kind',
        'observed_timestamp',
        'project',
        'reasoning_tokens',
        'run_id',
        'scope_name',
        'scope_version',
        'service_name',
        'severity_number',
        'severity_text',
        'task',
        'variant',
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

const durationAgainstOutputTokensPanel = panel({
  id: 6,
  type: 'trend',
  gridPos: { x: 0, y: 26, w: 12, h: 8 },
  title: 'Duration against output tokens',
  description:
    'Reads duration_ms and output_tokens on kind=model_call Events as raw log lines, a range query, skipping an Event missing either field. Extract fields splits the raw labels field, convertFieldType makes both fields numeric, Organize fields reduces the frame to exactly those two numeric fields with output_tokens first, and sortBy orders the rows by output_tokens ascending. Drawn as a `trend` panel, not `xychart`: the xychart plugin does not load in this Grafana image. The trend panel reads output_tokens as its x axis, points only (no connecting line), against duration_ms on the y axis.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${MODEL_SEL} | output_tokens != "" | duration_ms != ""`,
    }),
  ],
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'output_tokens', destinationType: 'number' },
          { targetField: 'duration_ms', destinationType: 'number' },
        ],
      },
    },
    organizeTransformation({
      order: ['output_tokens', 'duration_ms'],
      exclude: ['Time', 'Line', 'labels', 'tsNs', 'id'],
    }),
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'output_tokens', desc: false }] } },
  ],
  custom: SCATTER_POINT_STYLE,
  options: { xFieldName: 'output_tokens', ...SHARED_TIMESERIES_OPTIONS },
});

const durationAgainstInputTokensPanel = panel({
  id: 7,
  type: 'trend',
  gridPos: { x: 12, y: 26, w: 12, h: 8 },
  title: 'Duration against input tokens',
  description:
    'Reads duration_ms and input_tokens on kind=model_call Events as raw log lines, a range query, skipping an Event missing either field. Extract fields splits the raw labels field, convertFieldType makes both fields numeric. Unlike its output_tokens sibling, input_tokens takes only a handful of distinct values across hundreds of Events, so a raw per-row frame has long runs of a repeated x value; a trend panel demands a unique, ascending x field, so groupBy first collapses the duplicate input_tokens rows into one row per distinct value, averaging duration_ms. Organize fields renames the averaged column back to duration_ms and reduces the frame to exactly those two numeric fields with input_tokens first, and sortBy then orders the now-unique rows by input_tokens ascending. Drawn as a `trend` panel, not `xychart`: the xychart plugin does not load in this Grafana image. The trend panel reads input_tokens as its x axis, points only (no connecting line), against mean duration_ms on the y axis.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${MODEL_SEL} | input_tokens != "" | duration_ms != ""`,
    }),
  ],
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'input_tokens', destinationType: 'number' },
          { targetField: 'duration_ms', destinationType: 'number' },
        ],
      },
    },
    {
      id: 'groupBy',
      options: {
        fields: {
          input_tokens: { aggregations: [], operation: 'groupby' },
          duration_ms: { aggregations: ['mean'], operation: 'aggregate' },
        },
      },
    },
    organizeTransformation({
      order: ['input_tokens', 'duration_ms (mean)'],
      rename: { 'duration_ms (mean)': 'duration_ms' },
      exclude: ['Time', 'Line', 'labels', 'tsNs', 'id'],
    }),
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'input_tokens', desc: false }] } },
  ],
  custom: SCATTER_POINT_STYLE,
  options: { xFieldName: 'input_tokens', ...SHARED_TIMESERIES_OPTIONS },
});

const outputTokensPerSecondPanel = panel({
  id: 8,
  type: 'timeseries',
  gridPos: { x: 0, y: 34, w: 12, h: 8 },
  title: 'Output tokens per second, by model',
  description:
    'Reads output_tokens and duration_ms on kind=model_call Events, the summed output_tokens divided by the summed duration_ms (scaled from milliseconds to seconds) in each interval, one series per model.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${MODEL_SEL} | unwrap output_tokens [$__interval])) / (sum by (model) (sum_over_time(${MODEL_SEL} | unwrap duration_ms [$__interval])) / 1000)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const durationBySessionPanel = panel({
  id: 9,
  type: 'timeseries',
  gridPos: { x: 12, y: 34, w: 12, h: 8 },
  title: 'Model call duration over time, by Session',
  description:
    'Reads duration_ms on kind=model_call Events, the maximum value in each interval, one series per session_id. label_format shortens session_id to its first 8 characters before grouping, so the legend reads a short id rather than the full 36-character Session identifier, and the legend sits in a table to the right rather than a wide bottom list. Model calls are sparse relative to $__interval, so null buckets are bridged (spanNulls) and every point is drawn, turning what would otherwise be isolated dots into a readable line.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${MODEL_SEL} | label_format session_id="{{ trunc 8 .session_id }}" | unwrap duration_ms [$__interval]))`,
    }),
  ],
  custom: SPARSE_LINE_STYLE,
  options: {
    legend: { showLegend: true, displayMode: 'table', placement: 'right', calcs: [] },
    tooltip: { mode: 'multi', sort: 'desc' },
  },
  unit: 'ms',
});

// --- Tool call latency --------------------------------------------------

const toolDurationP95Panel = panel({
  id: 10,
  type: 'barchart',
  gridPos: { x: 0, y: 42, w: 12, h: 8 },
  title: 'Tool call duration p95, top 20 tools',
  description:
    'Reads duration_ms on kind=tool_call Events, the top 20 tools by 95th percentile duration over the selected range, descending, drawn as a horizontal `barchart` so every tool name labels its own bar.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{tool}}',
      expr: `topk(20, quantile_over_time(0.95, ${TOOL_SEL} | unwrap duration_ms [$__range]) by (tool))`,
    }),
  ],
  unit: 'ms',
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
});

const toolDurationHeatmapPanel = panel({
  id: 11,
  type: 'heatmap',
  gridPos: { x: 12, y: 42, w: 12, h: 8 },
  title: 'Tool call duration, distribution over time',
  description:
    'Reads duration_ms on kind=tool_call Events, bucketed into cumulative "le" bands by cumulative count_over_time, so the spread of tool call latency across the selected range is visible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{le}}',
      expr: cumulativeBucketExpr(
        TOOL_SEL,
        'duration_ms',
        [50, 100, 250, 500, 1000, 2500, 5000, 10000],
      ),
    }),
  ],
  options: {
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
  unit: 'ms',
});

const toolDurationByTypePanel = panel({
  id: 12,
  type: 'timeseries',
  gridPos: { x: 0, y: 50, w: 24, h: 8 },
  title: 'Tool call duration, p50 and p95, by tool_type',
  description:
    'Reads duration_ms and tool_type on kind=tool_call Events, the 50th and 95th percentile duration, one series set per tool_type, mcp against native.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 {{tool_type}}',
      expr: `quantile_over_time(0.5, ${TOOL_SEL} | unwrap duration_ms [$__interval]) by (tool_type)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p95 {{tool_type}}',
      expr: `quantile_over_time(0.95, ${TOOL_SEL} | unwrap duration_ms [$__interval]) by (tool_type)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const slowestToolCallsPanel = panel({
  id: 13,
  type: 'table',
  gridPos: { x: 0, y: 58, w: 24, h: 10 },
  title: 'Slowest 50 tool calls',
  description:
    'Reads kind=tool_call Events as raw log lines, a range query over the selected range. A label_format stage shortens session_id to 8 characters before the Extract fields transformation splits the raw labels field into one field per Event attribute, convertFieldType makes duration_ms and result_bytes numeric so duration_ms sorts correctly, and the table is sorted by duration_ms descending and limited to the slowest 50. Columns: the call Time, tool, Duration (ms, millisecond-unit override), Session and result_bytes, where present; every other Event attribute and log field the unprocessed logs query would otherwise show is dropped.',
  targets: [lokiTarget({ refId: 'A', expr: `${TOOL_SEL} ${SHORT_SESSION_ID_STAGE}` })],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'duration_ms', destinationType: 'number' },
          { targetField: 'result_bytes', destinationType: 'number' },
        ],
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'duration_ms', desc: true }] } },
    { id: 'limit', options: { limitField: 50 } },
    organizeTransformation({
      order: ['Time', 'tool', 'duration_ms', 'session_id', 'result_bytes'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'tool_type',
        'success',
        'mcp_server',
        'agent',
        'cache_read_tokens',
        'cache_write_tokens',
        'config',
        'detected_level',
        'host_arch',
        'kind',
        'observed_timestamp',
        'os_type',
        'os_version',
        'project',
        'reasoning_tokens',
        'run_id',
        'scope_name',
        'scope_version',
        'service_name',
        'service_version',
        'severity_number',
        'severity_text',
        'task',
        'variant',
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

// --- MCP server latency ---------------------------------------------------

const mcpTotalDurationPanel = panel({
  id: 14,
  type: 'timeseries',
  gridPos: { x: 0, y: 68, w: 12, h: 8 },
  title: 'mcp_server.total_ms, p50 and p95, per server',
  description:
    'Reads mcp_server.total_ms on kind=mcp_server_call Events, the 50th and 95th percentile duration, one series set per service_name.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 {{service_name}}',
      expr: `quantile_over_time(0.5, ${MCP_SEL} | unwrap mcp_server_total_ms [$__interval]) by (service_name)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p95 {{service_name}}',
      expr: `quantile_over_time(0.95, ${MCP_SEL} | unwrap mcp_server_total_ms [$__interval]) by (service_name)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const mcpInternalUpstreamStackedPanel = panel({
  id: 15,
  type: 'timeseries',
  gridPos: { x: 12, y: 68, w: 12, h: 8 },
  title: 'mcp_server.internal_ms and mcp_server.upstream_ms, stacked',
  description:
    "Reads mcp_server.internal_ms and mcp_server.upstream_ms on kind=mcp_server_call Events, both SHOULD attributes, summed per interval and stacked, so the split between a server's own work and its upstream wait is visible. Only 184 mcp_server_call Events exist, so this panel can return no data outside a narrow range.",
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'internal',
      expr: `sum(sum_over_time(${MCP_SEL} | mcp_server_internal_ms != "" | unwrap mcp_server_internal_ms [$__interval]))`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'upstream',
      expr: `sum(sum_over_time(${MCP_SEL} | mcp_server_upstream_ms != "" | unwrap mcp_server_upstream_ms [$__interval]))`,
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
  unit: 'ms',
});

const mcpTargetP95Panel = panel({
  id: 16,
  type: 'barchart',
  gridPos: { x: 0, y: 76, w: 24, h: 8 },
  title: 'mcp_server.total_ms p95, per target',
  description:
    'Reads mcp_server.total_ms and mcp_server.target on kind=mcp_server_call Events, the 95th percentile duration per target over the selected range, drawn as a horizontal `barchart` so every target name labels its own bar. mcp_server.target is a SHOULD attribute, so a call that omits it is absent from this panel.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{mcp_server_target}}',
      expr: `quantile_over_time(0.95, ${MCP_SEL} | mcp_server_target != "" | unwrap mcp_server_total_ms [$__range]) by (mcp_server_target)`,
    }),
  ],
  unit: 'ms',
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
});

export const exploreLatencyDashboard: Dashboard = dashboard({
  uid: 'explore-latency',
  title: 'Explore: latency',
  variables,
  // The captured Events span roughly a day; "now-7d" compresses every
  // chart against the right-hand edge, so this board defaults to 24h.
  time: { from: 'now-24h', to: 'now' },
  panels: [
    modelDurationPercentilesPanel,
    modelDurationHeatmapPanel,
    modelDurationHistogramPanel,
    modelMaxDurationPanel,
    slowestModelCallsPanel,
    durationAgainstOutputTokensPanel,
    durationAgainstInputTokensPanel,
    outputTokensPerSecondPanel,
    durationBySessionPanel,
    toolDurationP95Panel,
    toolDurationHeatmapPanel,
    toolDurationByTypePanel,
    slowestToolCallsPanel,
    mcpTotalDurationPanel,
    mcpInternalUpstreamStackedPanel,
    mcpTargetP95Panel,
  ],
});

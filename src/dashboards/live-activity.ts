import type { Dashboard } from '../schema/dashboard.js';
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
 * "Live, activity": the third of four experimental live boards (SPEC.md's
 * dashboards section). Shows the moment-by-moment stream of what the Agent
 * (a coding-agent command-line tool) is doing: which tool it is running,
 * on which Session, and how recently. Twelve panels, favouring variety of
 * Grafana panel type over polish, the same approach the Explore boards
 * take; the user keeps the panels that earn a place on a committed
 * dashboard and drops the rest. Every panel is built from `liveSelector`
 * in `./lib.ts`, so no panel ever hand-writes a stream selector, and every
 * panel still works when a stored Event carries no `session_label`,
 * falling back to the first 8 characters of `session_id`.
 *
 * Hard prohibition 3 in CLAUDE.md: no panel below ever reads prompt text,
 * tool input, or tool output. Every table and chart here shows only a
 * name, a count, a size, a duration, or a timestamp.
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

/**
 * `bargauge` draws a single unnamed bar when a query narrows to one
 * series (the Latency board's own note on the same fault): every per-tool
 * panel here that ranks a top-N list uses a horizontal `barchart` instead,
 * which always labels every category on its axis.
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

const STATE_TIMELINE_OPTIONS = {
  mergeValues: true,
  showValue: 'auto',
  alignValue: 'left',
  rowHeight: 0.9,
  legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] },
  tooltip: { mode: 'single', sort: 'none' },
};

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

/**
 * Rewrites the `session_label` field to the stream's own `session_label`
 * when it is set, or the first 8 characters of `session_id` otherwise.
 * Most ALREADY STORED Events carry no `session_label`, so every panel that
 * groups or labels by Session uses this stage rather than the raw
 * `session_label` attribute alone.
 */
const SESSION_LABEL_FALLBACK_STAGE =
  '| label_format session_label=`{{ if .session_label }}{{ .session_label }}{{ else }}{{ substr 0 8 .session_id }}{{ end }}`';

// --- The spine ------------------------------------------------------------

const lastToolCallsTablePanel = panel({
  id: 1,
  type: 'table',
  gridPos: { x: 0, y: 0, w: 24, h: 10 },
  title: 'Last 50 tool calls',
  description:
    'Reads kind=tool_call Events as raw log lines over the selected window, newest first, ' +
    "limited to the last 50. A label_format stage sets session_label to the stream's own " +
    'session_label, or the first 8 characters of session_id when it is absent, before Extract ' +
    'fields splits the raw labels field into one field per Event attribute, convertFieldType ' +
    'makes duration_ms numeric so it sorts and displays correctly, sortBy orders by Time ' +
    'descending, and limit keeps only the newest 50 rows. Columns: the call Time, Session ' +
    'label, tool name, Duration (ms), and whether it succeeded; no tool argument or tool ' +
    'result ever appears.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${liveSelector('tool_call')} ${SESSION_LABEL_FALLBACK_STAGE}`,
    }),
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
      order: ['Time', 'session_label', 'tool', 'duration_ms', 'success'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'tool_type',
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
        'result_bytes',
        'run_id',
        'scope_name',
        'scope_version',
        'service_name',
        'service_version',
        'severity_number',
        'severity_text',
        'session_id',
        'branch',
        'event_name',
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

// --- Right now --------------------------------------------------------------

const secondsSinceLastToolCallPanel = panel({
  id: 2,
  type: 'stat',
  gridPos: { x: 0, y: 10, w: 8, h: 6 },
  title: 'Time since last tool call',
  description:
    'Was a raw log selector with no metric function: a stat panel has no numeric field to ' +
    'reduce from a raw log line, so it always fell through to noValue even while the table ' +
    'above listed tool calls. Now a metric query: $__to (the built-in Grafana end-of-range ' +
    'variable, in Unix milliseconds) minus the latest observed_timestamp (converted from ' +
    "nanoseconds), grouped by session_id first so the aggregation never expands into Loki's " +
    'per-stream series limit over a wide window (the same `by (session_id)` shape the Live: ' +
    'now and Live: trouble boards already prove correct), then the outer min() picks the ' +
    'smallest elapsed time, the single most recent tool call across every Session the pickers ' +
    'allow. The unit "s" auto-scales seconds into minutes once the value passes 60, giving a ' +
    'reading such as "35 s" or "4.25 min". noValue reads "no tool call yet" when the window ' +
    'holds no kind=tool_call Event at all.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `min($__to - (max by (session_id) (max_over_time(${liveSelector('tool_call')} | unwrap observed_timestamp [$__range])) / 1000000)) / 1000`,
    }),
  ],
  unit: 's',
  noValue: 'no tool call yet',
  options: { ...STAT_OPTIONS, colorMode: 'none' },
});

const mostUsedToolLast5mPanel = panel({
  id: 3,
  type: 'stat',
  gridPos: { x: 8, y: 10, w: 8, h: 6 },
  title: 'Most used tool, last 5 minutes',
  description:
    'Reads kind=tool_call Events in a fixed trailing 5-minute window (independent of the ' +
    "dashboard's own selected range), the single tool with the highest call count, named by " +
    'legendFormat and its count as the stat value. Printed the literal "Value #A" above the ' +
    'number instead of the tool name: STAT_OPTIONS sets reduceOptions.values to false, and a ' +
    'Loki instant query returns one frame per series, so values: false collapsed every named ' +
    'series down to a single unnamed value. A scratch Grafana dashboard against the same query ' +
    'confirmed the fix: setting values: true drew the series correctly named. Now this panel ' +
    'overrides reduceOptions with values: true on top of the shared STAT_OPTIONS, the one stat ' +
    'panel on this board that names a series rather than showing a single aggregate number.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `topk(1, sum by (tool) (count_over_time(${liveSelector('tool_call')} [5m])))`,
    }),
  ],
  unit: 'short',
  noValue: 'idle',
  options: {
    ...STAT_OPTIONS,
    textMode: 'value_and_name',
    reduceOptions: { ...STAT_OPTIONS.reduceOptions, values: true },
  },
});

const activeSessionsInWindowPanel = panel({
  id: 4,
  type: 'stat',
  gridPos: { x: 16, y: 10, w: 8, h: 6 },
  title: 'Active sessions in window',
  description:
    'Counts the distinct session_label values (falling back to the first 8 characters of ' +
    'session_id when absent) that emitted any Event anywhere in the selected window. Was a ' +
    'range query over $__interval steps reduced to its lastNotNull value, so it reported only ' +
    'the Sessions active in the final bucket of the window, not the window as a whole, which ' +
    'disagreed with the table above it. Now a single instant query over the whole $__range, ' +
    'counting the outer count() of a sum by (session_label) inner aggregation rather than a ' +
    'plain count by (session_label): a direct query against this exact dataset confirmed count ' +
    'by (session_label) alone raises "maximum of series (500) reached for a single query" over ' +
    'a wide window, where sum by (session_label) does not, the same sum-by substitution ' +
    'activeSessionsNowPanel on the Live: now board already uses for the same reason.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `count(sum by (session_label) (count_over_time(${liveSelector()} ${SESSION_LABEL_FALLBACK_STAGE} [$__range])))`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  options: STAT_OPTIONS,
});

// --- Tool shape -------------------------------------------------------------

const toolCallCountsByToolPanel = panel({
  id: 5,
  type: 'barchart',
  gridPos: { x: 0, y: 16, w: 12, h: 8 },
  title: 'Tool call counts by tool, top 20',
  description:
    'Shows the top 20 tools by kind=tool_call Event count over the selected window, as a ' +
    'horizontal bar chart so every tool name labels its own bar.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `topk(20, sum by (tool) (count_over_time(${liveSelector('tool_call')} [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

const toolCallsPerMinuteByTypePanel = panel({
  id: 6,
  type: 'timeseries',
  gridPos: { x: 12, y: 16, w: 12, h: 8 },
  title: 'Tool calls per minute, mcp against native',
  description:
    'Stacks kind=tool_call Events in $__interval-stepped buckets over the selected window, one ' +
    'series per tool_type attribute, mcp against native. The bucket width is $__interval, not a ' +
    "fixed one-minute window: a fixed [1m] window is narrower than Grafana's own evaluation " +
    'step over a wide range, so every sample point looks back only one minute while the points ' +
    'sit much further apart, and a capture whose Events cluster into a short burst falls in the ' +
    'gap between sample points and the panel reads "No data", confirmed directly against Loki ' +
    'with step=900 over 24 hours: the [1m] window returned no series, the [$__interval] window ' +
    'returned both the mcp and the native series.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{tool_type}}',
      expr: `sum by (tool_type) (count_over_time(${liveSelector('tool_call')} [$__interval]))`,
    }),
  ],
  custom: STACKED_BAR_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const toolCallDurationHistogramPanel = panel({
  id: 7,
  type: 'histogram',
  gridPos: { x: 0, y: 24, w: 12, h: 8 },
  title: 'Tool call duration, distribution in window',
  description:
    'Reads duration_ms on kind=tool_call Events, the median duration per Session over the ' +
    'whole selected window, one value per session_label, binned across every Session sampled. ' +
    'Loki cannot histogram a raw per-call value because duration_ms is unwrapped rather than a ' +
    'label, so this is the per-Session distribution, the same limitation the Latency board notes ' +
    'for its own model-call duration histogram.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_label}}',
      expr: `quantile_over_time(0.5, ${liveSelector('tool_call')} ${SESSION_LABEL_FALLBACK_STAGE} | unwrap duration_ms [$__range]) by (session_label)`,
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

const resultBytesByToolPanel = panel({
  id: 8,
  type: 'barchart',
  gridPos: { x: 12, y: 24, w: 12, h: 8 },
  title: 'Result bytes by tool, top 20',
  description:
    'Sums result_bytes on kind=tool_call Events over the selected window, one named bar per ' +
    'tool, for the top 20 tools that report it, showing which tool floods the context. ' +
    'result_bytes is present only on a share of recorded Events, so a tool that never exposes ' +
    'it is absent from this panel rather than shown at zero.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{tool}}',
      expr: `topk(20, sum by (tool) (sum_over_time(${liveSelector('tool_call')} | result_bytes != "" | unwrap result_bytes [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'bytes',
});

// --- Model calls and turns ---------------------------------------------------

const lastModelCallsTablePanel = panel({
  id: 9,
  type: 'table',
  gridPos: { x: 0, y: 32, w: 24, h: 10 },
  title: 'Last 20 model calls',
  description:
    'Reads kind=model_call Events as raw log lines over the selected window, newest first, ' +
    "limited to the last 20. A label_format stage sets session_label to the stream's own " +
    'session_label, or the first 8 characters of session_id when it is absent, before Extract ' +
    'fields splits the raw labels field into one field per Event attribute, convertFieldType ' +
    'makes duration_ms and output_tokens numeric, sortBy orders by Time descending, and limit ' +
    'keeps only the newest 20 rows. Columns: the call Time, Session label, model, Duration ' +
    '(ms), and output tokens; no prompt text ever appears.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${liveSelector('model_call')} ${SESSION_LABEL_FALLBACK_STAGE}`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'duration_ms', destinationType: 'number' },
          { targetField: 'output_tokens', destinationType: 'number' },
        ],
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Time', desc: true }] } },
    { id: 'limit', options: { limitField: 20 } },
    organizeTransformation({
      order: ['Time', 'session_label', 'model', 'duration_ms', 'output_tokens'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'agent',
        'cache_read_tokens',
        'cache_write_tokens',
        'config',
        'cost_usd',
        'detected_level',
        'host_arch',
        'input_tokens',
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
        'session_id',
        'branch',
        'event_name',
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

const turnsOverTimePanel = panel({
  id: 10,
  type: 'timeseries',
  gridPos: { x: 0, y: 42, w: 24, h: 8 },
  title: 'Turns over time',
  description:
    'Counts kind=prompt Events, one turn per prompt Event, in fixed one-minute buckets over ' +
    'the selected window.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'turns',
      expr: `sum(count_over_time(${liveSelector('prompt')} [1m]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

// --- Rhythm -------------------------------------------------------------------

const sessionToolStateTimelinePanel = panel({
  id: 11,
  type: 'state-timeline',
  gridPos: { x: 0, y: 50, w: 24, h: 24 },
  title: 'Which tool each Session is running, top 20 pairs',
  description:
    'Shows one row per Session-and-tool pair, limited to the top 20 pairs by call count over ' +
    'the selected window (the same topk-per-step shape the Sessions board\'s "Session activity, ' +
    'by session" panel in explore-activity.ts uses for the same row-count fault), counting ' +
    'kind=tool_call Events in fixed one-minute buckets, so a Gantt-chart-like block appears ' +
    'while that Session is calling that tool and a gap appears otherwise. Unlimited, this panel ' +
    'drew 89 rows, one per distinct Session-and-tool pair, each labelled by a long concatenated ' +
    'string, a dense overlapping smear no operator could read. Each row is labelled by ' +
    'session_label (falling back to the first 8 characters of session_id when absent) and the ' +
    'tool name, and the panel is 24 grid rows tall, rather than the 8 rows most panels on this ' +
    'board use, so twenty rows stay legible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_label}} · {{tool}}',
      expr: `topk(20, sum by (session_label, tool) (count_over_time(${liveSelector('tool_call')} ${SESSION_LABEL_FALLBACK_STAGE} [1m])))`,
    }),
  ],
  custom: {},
  options: STATE_TIMELINE_OPTIONS,
  unit: 'short',
});

const eventKindsStateTimelinePanel = panel({
  id: 12,
  type: 'state-timeline',
  gridPos: { x: 0, y: 74, w: 24, h: 16 },
  title: 'Event kinds, over time',
  description:
    'Shows one row per Kind, counting every Event in fixed one-minute buckets over the ' +
    'selected window, including a record that reached no Kind. A label_format stage renames an ' +
    'empty kind to the literal "none" before grouping, so the rhythm of think (kind=prompt), ' +
    'act (kind=tool_call, kind=model_call), think is visible with every row legible.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{kind}}',
      expr: `sum by (kind) (count_over_time(${liveSelector()} | label_format kind=\`{{ if .kind }}{{ .kind }}{{ else }}none{{ end }}\` [1m]))`,
    }),
  ],
  custom: {},
  options: STATE_TIMELINE_OPTIONS,
  unit: 'short',
});

export const liveActivityDashboard: Dashboard = dashboard({
  uid: 'live-activity',
  title: 'Live, activity',
  variables,
  time: { from: 'now-1h', to: 'now' },
  refresh: '5s',
  timepicker: { refresh_intervals: ['5s', '10s'] },
  panels: [
    lastToolCallsTablePanel,
    secondsSinceLastToolCallPanel,
    mostUsedToolLast5mPanel,
    activeSessionsInWindowPanel,
    toolCallCountsByToolPanel,
    toolCallsPerMinuteByTypePanel,
    toolCallDurationHistogramPanel,
    resultBytesByToolPanel,
    lastModelCallsTablePanel,
    turnsOverTimePanel,
    sessionToolStateTimelinePanel,
    eventKindsStateTimelinePanel,
  ],
});

import type { Dashboard } from '../schema/dashboard.js';
import {
  dashboard,
  instantLokiTarget,
  labelVariable,
  lokiTarget,
  organizeTransformation,
  panel,
  selector,
} from './lib.js';

/**
 * Explore: tokens and cost. An exploration board, not a committed dashboard
 * (SPEC.md's dashboards section): fifteen panels over kind=model_call,
 * kind=run_end and kind=prompt Events, all built from the shared selector in
 * `./lib.ts` so no panel ever hand-writes a stream selector. The user keeps
 * the panels that earn their place and drops the rest, so this module
 * favours variety of visualisation type over polish.
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

const TABLE_CUSTOM = {
  align: 'auto',
  cellOptions: { type: 'auto' },
  inspect: false,
  filterable: true,
};

const TABLE_OPTIONS = {
  showHeader: true,
  cellHeight: 'sm',
  footer: { show: false, reducer: ['sum'], countRows: false, fields: '' },
};

/**
 * `trend` replaces `xychart` for the input/output token scatter (fault 1):
 * the xychart plugin does not load in this Grafana image, so the panel
 * draws as a `trend` panel with its line suppressed and every point marker
 * always drawn.
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
 * `session_id` is a 36-character UUID, unreadable as a legend entry or an
 * axis label. This LogQL `label_format` stage rewrites the label to its
 * first 8 characters before any `by (session_id)` grouping, so every panel
 * that splices it in shows a short, readable name instead of the full
 * identifier. It sits after the kind filter and before `| unwrap`, so the
 * unwrapped field is unaffected.
 */
const SHORT_SESSION_ID_STAGE = '| label_format session_id="{{ .session_id | trunc 8 }}"';

function shortSessionSelector(kind: string): string {
  return `${selector(kind)} ${SHORT_SESSION_ID_STAGE}`;
}

// --- Context growth ---------------------------------------------------

const contextGrowthPanel = panel({
  id: 1,
  type: 'timeseries',
  gridPos: { x: 0, y: 0, w: 24, h: 8 },
  title: 'Input tokens per model call, by Session',
  description:
    'The largest input_tokens value on a kind=model_call Event in each interval, one series per session_id, legend shortened to the first 8 characters of session_id. A rising line shows context growth within a Session. This is the most important panel on this board.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${shortSessionSelector('model_call')} | unwrap input_tokens [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const cumulativeInputTokensPanel = panel({
  id: 2,
  type: 'timeseries',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Cumulative input tokens',
  description:
    'The running total of input_tokens summed over kind=model_call Events, across every Session in the selected range, using a cumulative-sum field calculation over the per-interval sum, the same shape as the Cumulative cost panel below. The calculateField cumulativeFunctions transform collapses every input series into one running total rather than keeping one line per session_id, so this panel reports the total across every Session rather than a line per Session; the query drops the by (session_id) grouping the title used to imply, since the transform discarded it regardless.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${selector('model_call')} | unwrap input_tokens [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
  transformations: [
    {
      id: 'calculateField',
      options: { mode: 'cumulativeFunctions', cumulative: { field: 'Value', reducer: 'sum' } },
    },
    organizeTransformation({ order: ['Time', 'cumulative sum(Value)'], exclude: ['Value'] }),
  ],
});

const inputTokensScatterPanel = panel({
  id: 3,
  type: 'timeseries',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Input tokens over time, by Session, as points',
  description:
    'The largest input_tokens value on a kind=model_call Event in each interval, one series per session_id (legend shortened to the first 8 characters), drawn as points only, with no connecting line, so a Session with few Events still shows a dot rather than being lost against a default-styled line. This panel first tried the `trend` panel type: `trend` accepts exactly one frame and requires a strictly ascending x field, so a joinByField-then-sortBy pipeline merged the 24 per-session frames by Time before reaching it, and the panel still drew the error "Values must be in ascending order". `timeseries` renders each session_id frame natively, with no join and no ascending-x requirement, so this panel keeps the same query and drops the join and sort, and switches type instead.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${shortSessionSelector('model_call')} | unwrap input_tokens [$__interval]))`,
    }),
  ],
  custom: SCATTER_POINT_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

// --- Distributions ------------------------------------------------------

/**
 * `input_tokens` alone takes only two distinct values across the whole
 * capture (2 and 32), because Claude Code counts a cache read separately
 * from a fresh input token (fault 3). The total input a call actually
 * consumed is `input_tokens` plus `cache_read_tokens` plus
 * `cache_write_tokens`; a curl check against Loki confirmed this combined
 * figure has a real spread (roughly 32,660 to 366,222 across the
 * per-session maxima sampled). `add` is a Loki label_format template
 * function that parses its string-typed label arguments as numbers before
 * summing them, so no separate int-conversion stage is needed. The three
 * `!= ""` guards skip an Event missing one of the three fields, since
 * `add` has no defined result against a missing label.
 */
const TOTAL_INPUT_TOKENS_STAGE =
  '| input_tokens != "" | cache_read_tokens != "" | cache_write_tokens != "" ' +
  '| label_format total_input_tokens="{{ add .input_tokens .cache_read_tokens .cache_write_tokens }}"';

const inputTokensHistogramPanel = panel({
  id: 4,
  type: 'histogram',
  gridPos: { x: 0, y: 16, w: 8, h: 8 },
  title: 'Total input tokens consumed per call, distribution',
  description:
    'A histogram of input_tokens plus cache_read_tokens plus cache_write_tokens on kind=model_call Events, the total input a call actually consumed rather than input_tokens alone: the largest combined value in each interval, one series per session_id, binned across every sample in the range. input_tokens alone takes only two distinct values in the captured data (2 and 32), too narrow a range for a histogram to carry any information, because Claude Code counts a cache read separately from a fresh input token; summing all three input-related fields gives a figure that genuinely varies, confirmed with a curl check against Loki (roughly 32,660 to 366,222 across the per-session maxima sampled). Loki has no per-event series key, so this approximates the per-call distribution rather than returning one bin per raw Event.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${selector('model_call')} ${TOTAL_INPUT_TOKENS_STAGE} | unwrap total_input_tokens [$__interval]))`,
    }),
  ],
  custom: { fillOpacity: 80, lineWidth: 1 },
  options: {
    bucketOffset: 0,
    combine: true,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
  unit: 'short',
});

const outputTokensHistogramPanel = panel({
  id: 5,
  type: 'histogram',
  gridPos: { x: 8, y: 16, w: 8, h: 8 },
  title: 'Output tokens distribution',
  description:
    'A histogram of output_tokens sampled from kind=model_call Events: the largest value in each interval, one series per session_id, binned across every sample in the range. Loki has no per-event series key, so this approximates the per-call distribution rather than returning one bin per raw Event.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${selector('model_call')} | unwrap output_tokens [$__interval]))`,
    }),
  ],
  custom: { fillOpacity: 80, lineWidth: 1 },
  options: {
    bucketOffset: 0,
    combine: true,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
  unit: 'short',
});

const inputOutputScatterPanel = panel({
  id: 6,
  type: 'trend',
  gridPos: { x: 16, y: 16, w: 8, h: 8 },
  title: 'Input tokens against output tokens',
  description:
    'Reads input_tokens and output_tokens on kind=model_call Events as raw log lines, a range query, skipping an Event missing either field, one point per model call. Extract fields splits the raw labels field, convertFieldType makes both fields numeric, Organize fields reduces the frame to exactly those two numeric fields with output_tokens first, and sortBy orders the rows by output_tokens ascending. Drawn as a `trend` panel, not `xychart`: the xychart plugin does not load in this Grafana image. The trend panel reads output_tokens as its x axis, points only (no connecting line), against input_tokens on the y axis. output_tokens, not input_tokens, is the x field: input_tokens takes only two distinct values in the captured data (2 and 32, see the histogram panel above), and a trend panel with that many tied x values failed to render ("Values must be in ascending order"); output_tokens varies widely, the same reason the Latency board\'s "Duration against output tokens" panel uses it as an x field rather than input_tokens.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${selector('model_call')} | input_tokens != "" | output_tokens != ""`,
    }),
  ],
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'output_tokens', destinationType: 'number' },
          { targetField: 'input_tokens', destinationType: 'number' },
        ],
      },
    },
    organizeTransformation({
      order: ['output_tokens', 'input_tokens'],
      exclude: ['Time', 'Line', 'labels', 'tsNs', 'id'],
    }),
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'output_tokens', desc: false }] } },
  ],
  custom: SCATTER_POINT_STYLE,
  options: { xFieldName: 'output_tokens' },
  unit: 'short',
});

// --- Rates and totals -----------------------------------------------------

const outputTokensPerMinutePanel = panel({
  id: 7,
  type: 'timeseries',
  gridPos: { x: 0, y: 24, w: 24, h: 8 },
  title: 'Output tokens per minute, by model',
  description:
    'The sum of output_tokens on kind=model_call Events over each $__interval window, one series per model, divided by the window length in minutes so the figure is a genuine per-minute rate rather than the raw per-interval total.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${selector('model_call')} | unwrap output_tokens [$__interval])) / ($__interval_ms / 60000)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const totalInputTokensPanel = panel({
  id: 8,
  type: 'stat',
  gridPos: { x: 0, y: 32, w: 6, h: 6 },
  title: 'Total input tokens in range',
  description: 'The sum of input_tokens over every kind=model_call Event in the selected range.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${selector('model_call')} | unwrap input_tokens [$__range]))`,
    }),
  ],
  unit: 'short',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const totalOutputTokensPanel = panel({
  id: 9,
  type: 'stat',
  gridPos: { x: 6, y: 32, w: 6, h: 6 },
  title: 'Total output tokens in range',
  description: 'The sum of output_tokens over every kind=model_call Event in the selected range.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${selector('model_call')} | unwrap output_tokens [$__range]))`,
    }),
  ],
  unit: 'short',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const totalTokensByModelPanel = panel({
  id: 10,
  type: 'barchart',
  gridPos: { x: 12, y: 32, w: 12, h: 6 },
  title: 'Total tokens by model',
  description:
    'The sum of input_tokens and output_tokens over every kind=model_call Event in the selected range, grouped by model, as two series per model. Each query carries a legendFormat of {{model}}, so the model name, not a synthetic series name, labels every row.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${selector('model_call')} | unwrap input_tokens [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'B',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${selector('model_call')} | unwrap output_tokens [$__range]))`,
    }),
  ],
  options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] } },
  transformations: [
    { id: 'joinByField', options: { byField: 'model', mode: 'outer' } },
    organizeTransformation({
      order: ['model', 'Value #A', 'Value #B'],
      rename: { 'Value #A': 'input tokens', 'Value #B': 'output tokens' },
    }),
  ],
  unit: 'short',
});

const cacheReadShareOfRunsPanel = panel({
  id: 11,
  type: 'gauge',
  gridPos: { x: 0, y: 38, w: 6, h: 8 },
  title: 'Cache-read share of input tokens, by Run',
  description:
    'cache_read_tokens divided by the sum of cache_read_tokens and input_tokens, summed over every kind=run_end Event in the selected range, as a true 0-100% share. Only a replayed or benched Session carries a run_end Event, and there are 304 of them, so this gauge is thin by nature.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${selector('run_end')} | unwrap cache_read_tokens [$__range])) / (sum(sum_over_time(${selector('run_end')} | unwrap cache_read_tokens [$__range])) + sum(sum_over_time(${selector('run_end')} | unwrap input_tokens [$__range])))`,
    }),
  ],
  unit: 'percentunit',
  decimals: 4,
  max: 1,
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    showThresholdLabels: false,
    showThresholdMarkers: true,
  },
});

// --- Cost -----------------------------------------------------------------

const costPerSessionPanel = panel({
  id: 12,
  type: 'table',
  gridPos: { x: 6, y: 38, w: 18, h: 8 },
  title: 'Cost per Session',
  description:
    'One row per session_id that reports a cost: the count of kind=model_call Events and the sum of cost_usd on those Events, in the selected range. Only 96 of 28596 model_call Events carry cost_usd at all, so this table covers only calls that report a cost and is short by nature; the join that builds it also carries a duplicate Time column from each side, dropped here.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum by (session_id) (count_over_time(${selector('model_call')} [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'B',
      expr: `sum by (session_id) (sum_over_time(${selector('model_call')} | unwrap cost_usd [$__range]))`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'joinByField', options: { byField: 'session_id', mode: 'outer' } },
    organizeTransformation({
      order: ['session_id', 'Value #A', 'Value #B'],
      rename: { 'Value #A': 'model calls', 'Value #B': 'total cost_usd' },
      exclude: ['Time 1', 'Time 2'],
    }),
    {
      id: 'filterByValue',
      options: {
        filters: [{ fieldName: 'total cost_usd', config: { id: 'isNotNull', options: {} } }],
        type: 'include',
        match: 'any',
      },
    },
  ],
  overrides: [
    {
      matcher: { id: 'byName', options: 'total cost_usd' },
      properties: [{ id: 'unit', value: 'currencyUSD' }],
    },
  ],
});

const cumulativeCostPanel = panel({
  id: 13,
  type: 'timeseries',
  gridPos: { x: 0, y: 46, w: 24, h: 8 },
  title: 'Cumulative cost',
  description:
    'The running total of cost_usd summed over kind=model_call Events, across every Session in the selected range, using a cumulative-sum field calculation over the per-interval sum. Only 96 of 28596 model_call Events carry cost_usd, so this line is sparse and mostly flat.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${selector('model_call')} | unwrap cost_usd [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'currencyUSD',
  transformations: [
    {
      id: 'calculateField',
      options: { mode: 'cumulativeFunctions', cumulative: { field: 'Value', reducer: 'sum' } },
    },
    organizeTransformation({ order: ['Time', 'cumulative sum(Value)'], exclude: ['Value'] }),
  ],
});

// --- Prompts ----------------------------------------------------------------

const promptsPerMinutePanel = panel({
  id: 14,
  type: 'timeseries',
  gridPos: { x: 0, y: 54, w: 12, h: 8 },
  title: 'Prompts per minute, by Session',
  description:
    'Counts kind=prompt Events in each trailing one-minute window, one series per session_id, legend shortened to the first 8 characters of session_id.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${shortSessionSelector('prompt')} [1m]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const topPromptCountsPanel = panel({
  id: 15,
  type: 'barchart',
  gridPos: { x: 12, y: 54, w: 12, h: 8 },
  title: 'Prompt count per Session, top 20',
  description:
    'Counts kind=prompt Events in the selected range, one bar per session_id, limited to the twenty busiest Sessions. The x axis label is shortened to the first 8 characters of session_id so the bars stay readable. A barchart needs session_id as an actual field, not only a per-frame label, to use it as the x axis category, so a joinByField on session_id (the same mechanism Cost per Session and Total tokens by model use below) merges the one-frame-per-session result into a single table before sortBy and limit run.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${shortSessionSelector('prompt')} [$__range]))`,
    }),
  ],
  options: { legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] } },
  transformations: [
    { id: 'joinByField', options: { byField: 'session_id', mode: 'outer' } },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Value', desc: true }] } },
    { id: 'limit', options: { limitField: 20 } },
  ],
  unit: 'short',
});

export const exploreTokensDashboard: Dashboard = dashboard({
  uid: 'explore-tokens',
  title: 'Explore: tokens and cost',
  variables,
  // The captured Events span roughly a day; "now-7d" compresses every
  // chart against the right-hand edge, so this board defaults to 24h.
  time: { from: 'now-24h', to: 'now' },
  panels: [
    contextGrowthPanel,
    cumulativeInputTokensPanel,
    inputTokensScatterPanel,
    inputTokensHistogramPanel,
    outputTokensHistogramPanel,
    inputOutputScatterPanel,
    outputTokensPerMinutePanel,
    totalInputTokensPanel,
    totalOutputTokensPanel,
    totalTokensByModelPanel,
    cacheReadShareOfRunsPanel,
    costPerSessionPanel,
    cumulativeCostPanel,
    promptsPerMinutePanel,
    topPromptCountsPanel,
  ],
});

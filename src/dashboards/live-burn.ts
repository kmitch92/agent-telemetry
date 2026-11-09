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
 * Live: burn rate. The second of four experimental live boards (SPEC.md's
 * dashboards section): tokens and money, per minute and in total, over a
 * live Session, so the operator can see what a Session is costing them
 * while there is still time to stop it. Favours breadth of panel type over
 * polish: the user keeps the panels that earn a place and drops the rest.
 * Every panel is built from `liveSelector` in `./lib.ts`, never a
 * hand-written stream selector, so every panel respects the usual pickers
 * plus the `session_label` and `branch` filters this board adds.
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

const STACKED_AREA_STYLE = {
  drawStyle: 'line',
  lineWidth: 1,
  fillOpacity: 40,
  showPoints: 'never',
  pointSize: 5,
  barAlignment: 0,
  axisPlacement: 'auto',
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
 * Most ALREADY STORED Events have no `session_label`, so every panel that
 * groups or labels by it falls back to the first 8 characters of
 * `session_id` when `session_label` is empty, the same `label_format`
 * if/else idiom `explore-activity.ts` uses for an empty `kind`.
 */
const SESSION_LABEL_FALLBACK_STAGE =
  '| label_format session_label=`{{ if .session_label }}{{ .session_label }}{{ else }}{{ substr 0 8 .session_id }}{{ end }}`';

/**
 * `input_tokens` alone takes only three distinct values across the whole
 * capture (0, 2 and 32), because Claude Code counts a cache read and a
 * cache write separately from a fresh input token. The figure that
 * actually varies, and the one a burn-rate panel needs, is `input_tokens`
 * plus `output_tokens` plus `cache_read_tokens` plus `cache_write_tokens`:
 * every token a call consumed or produced, on either side. The four
 * `!= ""` guards skip an Event missing one of the four fields, since `add`
 * has no defined result against a missing label, the same guard
 * `explore-tokens.ts` uses for its three-field `total_input_tokens`.
 */
const TOTAL_TOKENS_STAGE =
  '| input_tokens != "" | output_tokens != "" | cache_read_tokens != "" | cache_write_tokens != "" ' +
  '| label_format total_tokens="{{ add .input_tokens .output_tokens .cache_read_tokens .cache_write_tokens }}"';

function liveModelCallTotalTokensSelector(): string {
  return `${liveSelector('model_call')} ${SESSION_LABEL_FALLBACK_STAGE} ${TOTAL_TOKENS_STAGE}`;
}

// --- Right now --------------------------------------------------------

const tokensPerMinuteNowPanel = panel({
  id: 1,
  type: 'stat',
  gridPos: { x: 0, y: 0, w: 8, h: 6 },
  title: 'Tokens per minute, right now',
  description:
    'The sum of input_tokens, output_tokens, cache_read_tokens and cache_write_tokens on kind=model_call Events in the trailing 5 minutes, divided by 5, across every active Session that matches the pickers. A fixed 5-minute window, not the dashboard time range, so this reads the current rate even when the picker is set to look further back. The `or (... * 0)` term reports a true zero when no call landed in the last 5 minutes, and no Event is fabricated. The noValue field backs that up with a literal 0 when Loki returns no matching stream at all. If the stored Events include a replayed capture, several log lines share one near-identical timestamp, so a rate figure over that stretch reads far higher than any live Session could produce; the same panel reads correctly once a live Session is running.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `(sum(sum_over_time(${liveModelCallTotalTokensSelector()} | unwrap total_tokens [5m])) or (sum(count_over_time(${liveSelector('model_call')} [5m])) * 0)) / 5`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  options: STAT_OPTIONS,
});

const dollarsPerHourNowPanel = panel({
  id: 2,
  type: 'stat',
  gridPos: { x: 16, y: 0, w: 8, h: 6 },
  title: 'Money, extrapolated per hour',
  description:
    'The sum of cost_usd on kind=model_call Events in the trailing 15 minutes, multiplied by four to extrapolate a dollars-per-hour figure, across every active Session that matches the pickers. Only about 96 of 28596 model_call Events in the captured data carry cost_usd at all, so this stat is frequently empty or reads a true zero; that is honest, not a bug, and no price table is invented to fill the gap. The `or (... * 0)` term reports a true zero when no call in the window carries cost_usd, and the noValue field reads `no spend yet` instead of "No data" when Loki returns no matching stream at all. If the stored Events include a replayed capture, several model_call Events share one near-identical timestamp, so an extrapolated dollars-per-hour figure over that stretch can read far higher than any live Session could spend; the same panel reads correctly once a live Session is running.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `(sum(sum_over_time(${liveSelector('model_call')} | unwrap cost_usd [15m])) or (sum(count_over_time(${liveSelector('model_call')} [15m])) * 0)) * 4`,
    }),
  ],
  unit: 'currencyUSD',
  decimals: 2,
  noValue: 'no spend yet',
  options: STAT_OPTIONS,
});

const activeSessionsNowPanel = panel({
  id: 11,
  type: 'stat',
  gridPos: { x: 8, y: 0, w: 8, h: 6 },
  title: 'Active Sessions, right now',
  description:
    'Counts the distinct session_id values emitting any Event in the trailing 5 minutes, the same fixed window the two rate stats on this row use, so all three numbers describe the same "right now".',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `count(count by (session_id) (count_over_time(${liveSelector()} [5m])))`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  options: STAT_OPTIONS,
});

// --- Over the window ----------------------------------------------------

const tokensPerMinuteBySessionPanel = panel({
  id: 3,
  type: 'timeseries',
  gridPos: { x: 0, y: 6, w: 24, h: 8 },
  title: 'Tokens per minute, by Session',
  description:
    'The sum of input_tokens, output_tokens, cache_read_tokens and cache_write_tokens on kind=model_call Events in each $__interval window, one series per session_label, divided by the window length in minutes so the figure is a genuine per-minute rate. A Session with no session_label is shown under the first 8 characters of its session_id instead, so one runaway Session still stands out by name. If the stored Events include a replayed capture, many log lines share one near-identical timestamp and land in the same $__interval bucket, so this panel can read in the tens of millions over a historical window; the figure is correct once read against a live Session.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_label}}',
      expr: `sum by (session_label) (sum_over_time(${liveModelCallTotalTokensSelector()} | unwrap total_tokens [$__interval])) / ($__interval_ms / 60000)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const tokenKindStackedAreaPanel = panel({
  id: 4,
  type: 'timeseries',
  gridPos: { x: 0, y: 14, w: 12, h: 8 },
  title: 'Input, output, cache-read and cache-write tokens, stacked',
  description:
    'The sum of input_tokens, output_tokens, cache_read_tokens and cache_write_tokens on kind=model_call Events in each $__interval window, four stacked series, across every active Session that matches the pickers, so which kind of token dominates the current burn is visible at a glance.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'input',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | input_tokens != "" | unwrap input_tokens [$__interval]))`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'output',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | output_tokens != "" | unwrap output_tokens [$__interval]))`,
    }),
    lokiTarget({
      refId: 'C',
      legendFormat: 'cache read',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | cache_read_tokens != "" | unwrap cache_read_tokens [$__interval]))`,
    }),
    lokiTarget({
      refId: 'D',
      legendFormat: 'cache write',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | cache_write_tokens != "" | unwrap cache_write_tokens [$__interval]))`,
    }),
  ],
  custom: STACKED_AREA_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const cacheReadShareGaugePanel = panel({
  id: 5,
  type: 'gauge',
  gridPos: { x: 12, y: 14, w: 6, h: 8 },
  title: 'Cache-read share of input-side tokens',
  description:
    'cache_read_tokens divided by the sum of cache_read_tokens, input_tokens and cache_write_tokens, summed over kind=model_call Events in the selected range, as a true 0-100% share, so the operator can tell whether the cache is working right now rather than paying full price for repeated context.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | cache_read_tokens != "" | unwrap cache_read_tokens [$__range])) / (sum(sum_over_time(${liveSelector('model_call')} | cache_read_tokens != "" | unwrap cache_read_tokens [$__range])) + sum(sum_over_time(${liveSelector('model_call')} | input_tokens != "" | unwrap input_tokens [$__range])) + sum(sum_over_time(${liveSelector('model_call')} | cache_write_tokens != "" | unwrap cache_write_tokens [$__range])))`,
    }),
  ],
  unit: 'percentunit',
  decimals: 4,
  max: 1,
  options: GAUGE_OPTIONS,
});

const tokensByModelPanel = panel({
  id: 7,
  type: 'barchart',
  gridPos: { x: 18, y: 14, w: 6, h: 8 },
  title: 'Tokens by model',
  description:
    'The sum of input_tokens, output_tokens, cache_read_tokens and cache_write_tokens on kind=model_call Events in the selected range, grouped by model, as a horizontal bar chart, so an expensive model stands out from a cheap one.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${liveModelCallTotalTokensSelector()} | unwrap total_tokens [$__range]))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

// --- Per Session ----------------------------------------------------------

const perSessionTablePanel = panel({
  id: 6,
  type: 'table',
  gridPos: { x: 0, y: 22, w: 24, h: 8 },
  title: 'Per-Session burn, in the selected range',
  description:
    "One row per session_label (falling back to the first 8 characters of session_id when the label is empty): tokens so far, the sum of input_tokens, output_tokens, cache_read_tokens and cache_write_tokens on kind=model_call Events; and cost so far, the sum of cost_usd. Claude Code's own Events do not emit a cost_usd field at all, so cost so far is blank for a Claude Code Session; it fills only once a Run records an Event that carries cost_usd. Both targets are instant queries taken at the same moment, so the join also carries one Time column repeating that single identical instant on every row; it is dropped here as noise, not data.",
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `sum by (session_label) (sum_over_time(${liveModelCallTotalTokensSelector()} | unwrap total_tokens [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'B',
      expr: `sum by (session_label) (sum_over_time(${liveSelector('model_call')} ${SESSION_LABEL_FALLBACK_STAGE} | unwrap cost_usd [$__range]))`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'joinByField', options: { byField: 'session_label', mode: 'outer' } },
    organizeTransformation({
      order: ['session_label', 'Value #A', 'Value #B'],
      rename: {
        'Value #A': 'tokens so far',
        'Value #B': 'cost so far',
      },
      exclude: ['Time', 'Time 1', 'Time 2'],
    }),
  ],
  overrides: [
    {
      matcher: { id: 'byName', options: 'cost so far' },
      properties: [{ id: 'unit', value: 'currencyUSD' }],
    },
  ],
});

// --- Totals and extremes ----------------------------------------------------

const cumulativeCostPanel = panel({
  id: 8,
  type: 'timeseries',
  gridPos: { x: 0, y: 30, w: 12, h: 8 },
  title: 'Cumulative money spent, since the window began',
  description:
    "The running total of cost_usd summed over kind=model_call Events, across every active Session that matches the pickers, using a cumulative-sum field calculation over the per-interval sum, in the selected range. Claude Code's own Events do not emit a cost_usd field at all, so this line stays at the noValue reading `no cost recorded` for a Claude Code Session; it fills only once a Run records an Event that carries cost_usd.",
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `sum(sum_over_time(${liveSelector('model_call')} | unwrap cost_usd [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'currencyUSD',
  noValue: 'no cost recorded',
  transformations: [
    {
      id: 'calculateField',
      options: { mode: 'cumulativeFunctions', cumulative: { field: 'Value', reducer: 'sum' } },
    },
    organizeTransformation({ order: ['Time', 'cumulative sum(Value)'], exclude: ['Value'] }),
  ],
});

const reasoningTokensPerMinutePanel = panel({
  id: 10,
  type: 'timeseries',
  gridPos: { x: 12, y: 30, w: 12, h: 8 },
  title: 'Reasoning tokens per minute, by model',
  description:
    'The sum of reasoning_tokens on kind=model_call Events over each $__interval window, one series per model, divided by the window length in minutes, so a reasoning-heavy model that quietly drives up the burn rate stands out. A model that never reports reasoning_tokens is absent from this panel rather than shown at zero. The same replayed-capture clustering that inflates the token-per-minute panels on this board applies here too: a historical window can read unrealistically high, and the figure is correct once read against a live Session.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${liveSelector('model_call')} | reasoning_tokens != "" | unwrap reasoning_tokens [$__interval])) / ($__interval_ms / 60000)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const mostExpensiveCallPanel = panel({
  id: 9,
  type: 'table',
  gridPos: { x: 0, y: 38, w: 12, h: 8 },
  title: 'Most expensive model call in the window',
  description:
    'Reads kind=model_call Events that carry cost_usd as raw log lines, a range query over the selected range, sorted by cost_usd descending and limited to the single most expensive call, with its model, duration_ms and Session shown alongside, falling back to the first 8 characters of session_id when session_label is empty. Shown as a one-row table rather than a stat, because a stat panel has no way to tie one field\'s maximum to another field on the same Event. Only about 96 of 28596 model_call Events carry cost_usd, so this table is frequently empty; that is honest, not a bug. The noValue field reads `no spend yet` instead of "No data" when no Event in the selected range carries cost_usd.',
  targets: [
    lokiTarget({
      refId: 'A',
      expr: `${liveSelector('model_call')} ${SESSION_LABEL_FALLBACK_STAGE} | cost_usd != ""`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  noValue: 'no spend yet',
  transformations: [
    { id: 'extractFields', options: { source: 'labels', format: 'json' } },
    {
      id: 'convertFieldType',
      options: {
        conversions: [
          { targetField: 'cost_usd', destinationType: 'number' },
          { targetField: 'duration_ms', destinationType: 'number' },
        ],
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'cost_usd', desc: true }] } },
    { id: 'limit', options: { limitField: 1 } },
    organizeTransformation({
      order: ['Time', 'model', 'cost_usd', 'duration_ms', 'session_label'],
      exclude: [
        'labels',
        'Line',
        'tsNs',
        'id',
        'agent',
        'branch',
        'cache_read_tokens',
        'cache_write_tokens',
        'detected_level',
        'input_tokens',
        'kind',
        'observed_timestamp',
        'output_tokens',
        'project',
        'reasoning_tokens',
        'run_id',
        'scope_name',
        'scope_version',
        'service_name',
        'session_id',
        'severity_number',
        'severity_text',
        'task',
        'variant',
      ],
    }),
  ],
  overrides: [
    {
      matcher: { id: 'byName', options: 'cost_usd' },
      properties: [{ id: 'unit', value: 'currencyUSD' }],
    },
    {
      matcher: { id: 'byName', options: 'duration_ms' },
      properties: [{ id: 'unit', value: 'ms' }],
    },
  ],
});

const costByModelPanel = panel({
  id: 12,
  type: 'barchart',
  gridPos: { x: 12, y: 38, w: 12, h: 8 },
  title: 'Cost by model, in the selected range',
  description:
    "The sum of cost_usd on kind=model_call Events in the selected range, grouped by model, as a horizontal bar chart, so an expensive model stands out by price rather than only by token count. Claude Code's own Events do not emit a cost_usd field at all, so this chart stays at the noValue reading `no cost recorded` for a Claude Code Session; it fills only once a Run records an Event that carries cost_usd.",
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{model}}',
      expr: `sum by (model) (sum_over_time(${liveSelector('model_call')} | unwrap cost_usd [$__range]))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'currencyUSD',
  noValue: 'no cost recorded',
});

export const liveBurnDashboard: Dashboard = dashboard({
  uid: 'live-burn',
  title: 'Live, burn rate',
  variables,
  time: { from: 'now-1h', to: 'now' },
  refresh: '5s',
  timepicker: { refresh_intervals: ['5s', '10s'] },
  panels: [
    tokensPerMinuteNowPanel,
    activeSessionsNowPanel,
    dollarsPerHourNowPanel,
    tokensPerMinuteBySessionPanel,
    tokenKindStackedAreaPanel,
    cacheReadShareGaugePanel,
    tokensByModelPanel,
    perSessionTablePanel,
    cumulativeCostPanel,
    reasoningTokensPerMinutePanel,
    mostExpensiveCallPanel,
    costByModelPanel,
  ],
});

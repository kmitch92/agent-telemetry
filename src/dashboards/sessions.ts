import type { Dashboard } from '../schema/dashboard.js';
import { dashboard, labelVariable, lokiTarget, panel, selector } from './lib.js';

/**
 * The Sessions dashboard (SPEC.md's dashboards section): one row per Session
 * plus eight supporting panels, all built from the shared selector in
 * `./lib.ts` so no panel ever hand-writes a stream selector.
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

const sessionsPanel = panel({
  id: 1,
  type: 'table',
  gridPos: { x: 0, y: 0, w: 24, h: 10 },
  title: 'Sessions',
  description:
    'One row per Session, newest first. Start and last event come from observed_timestamp on every Event, in milliseconds. Model calls count kind=model_call Events, tool calls count kind=tool_call Events, and input tokens sum input_tokens on kind=model_call. Open means the Session has an Event in the last 30 minutes. Cost is absent on purpose: see Known gaps in README.md.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      expr: `min_over_time(${selector()} | unwrap observed_timestamp [$__range]) by (session_id, agent, project, run_id) / 1000000`,
    }),
    lokiTarget({
      refId: 'B',
      instant: true,
      expr: `max_over_time(${selector()} | unwrap observed_timestamp [$__range]) by (session_id) / 1000000`,
    }),
    lokiTarget({
      refId: 'C',
      instant: true,
      expr: `sum by (session_id) (count_over_time(${selector('model_call')} [$__range]))`,
    }),
    lokiTarget({
      refId: 'D',
      instant: true,
      expr: `sum by (session_id) (count_over_time(${selector('tool_call')} [$__range]))`,
    }),
    lokiTarget({
      refId: 'E',
      instant: true,
      expr: `sum by (session_id) (sum_over_time(${selector('model_call')} | unwrap input_tokens [$__range]))`,
    }),
    lokiTarget({
      refId: 'F',
      instant: true,
      expr: `sum by (session_id) (count_over_time(${selector()} [30m]))`,
    }),
  ],
  custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false, filterable: true },
  options: {
    showHeader: true,
    cellHeight: 'sm',
    footer: { show: false, reducer: ['sum'], countRows: false, fields: '' },
  },
  transformations: [
    { id: 'joinByField', options: { byField: 'session_id', mode: 'outer' } },
    {
      id: 'organize',
      options: {
        excludeByName: {
          Time: true,
          'Time 1': true,
          'Time 2': true,
          'Time 3': true,
          'Time 4': true,
          'Time 5': true,
          'Time 6': true,
        },
        includeByName: {},
        indexByName: {
          session_id: 0,
          agent: 1,
          project: 2,
          'Value #A': 3,
          'Value #B': 4,
          'Value #F': 5,
          'Value #C': 6,
          'Value #D': 7,
          'Value #E': 8,
          run_id: 9,
        },
        renameByName: {
          'Value #A': 'start',
          'Value #B': 'last event',
          'Value #C': 'model calls',
          'Value #D': 'tool calls',
          'Value #E': 'input tokens',
          'Value #F': 'open',
        },
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'last event', desc: true }] } },
  ],
  overrides: [
    {
      matcher: { id: 'byNames', options: { mode: 'include', names: ['start', 'last event'] } },
      properties: [{ id: 'unit', value: 'dateTimeAsIso' }],
    },
    {
      matcher: { id: 'byName', options: 'open' },
      properties: [
        {
          id: 'mappings',
          value: [
            { type: 'special', options: { match: 'null', result: { text: 'closed', index: 0 } } },
            {
              type: 'range',
              options: { from: 0, to: 100000000000, result: { text: 'open', index: 1 } },
            },
          ],
        },
      ],
    },
  ],
});

const sessionsStartedPanel = panel({
  id: 2,
  type: 'timeseries',
  gridPos: { x: 0, y: 10, w: 12, h: 8 },
  title: 'Sessions started over time, by agent',
  description:
    'Counts the distinct Sessions with at least one Event in each interval, grouped by agent. Reads every Kind: model_call, tool_call, prompt and run_end all count. LogQL cannot bucket a Session by its first Event, so this panel shows Session activity, not first appearance.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{agent}}',
      expr: `count by (agent) (sum by (session_id, agent) (count_over_time(${selector()} [$__interval])))`,
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

const modelCallsPanel = panel({
  id: 3,
  type: 'timeseries',
  gridPos: { x: 12, y: 10, w: 12, h: 8 },
  title: 'Model calls over time, by Session',
  description: 'Counts kind=model_call Events in each interval, one series per Session.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${selector('model_call')} [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const inputTokensPanel = panel({
  id: 4,
  type: 'timeseries',
  gridPos: { x: 0, y: 18, w: 12, h: 8 },
  title: 'Input tokens per model call',
  description:
    'The largest input_tokens value on a kind=model_call Event in each interval, one series per Session. A rising line shows context growth.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `max by (session_id) (max_over_time(${selector('model_call')} | unwrap input_tokens [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const outputTokensPanel = panel({
  id: 5,
  type: 'timeseries',
  gridPos: { x: 12, y: 18, w: 12, h: 8 },
  title: 'Output tokens per call',
  description:
    'The mean output_tokens value on kind=model_call Events in each interval, one series per Session.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_id}}',
      expr: `avg by (session_id) (avg_over_time(${selector('model_call')} | unwrap output_tokens [$__interval]))`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

const CACHE_READ = `sum(sum_over_time(${selector('model_call')} | unwrap cache_read_tokens [$__range]))`;
const INPUT = `sum(sum_over_time(${selector('model_call')} | unwrap input_tokens [$__range]))`;

const cacheReadSharePanel = panel({
  id: 6,
  type: 'stat',
  gridPos: { x: 0, y: 26, w: 6, h: 6 },
  title: 'Cache-read share of input tokens',
  description:
    'cache_read_tokens divided by the sum of cache_read_tokens and input_tokens, over every kind=model_call Event in the selected range.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      expr: `${CACHE_READ} / (${CACHE_READ} + ${INPUT})`,
    }),
  ],
  unit: 'percentunit',
  decimals: 4,
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const latencyPanel = panel({
  id: 7,
  type: 'timeseries',
  gridPos: { x: 6, y: 26, w: 18, h: 6 },
  title: 'Model call latency, p50 and p95, by agent',
  description:
    'The 50th and 95th percentile of duration_ms on kind=model_call Events, one pair of series per agent.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: 'p50 {{agent}}',
      expr: `quantile_over_time(0.5, ${selector('model_call')} | unwrap duration_ms [$__interval]) by (agent)`,
    }),
    lokiTarget({
      refId: 'B',
      legendFormat: 'p95 {{agent}}',
      expr: `quantile_over_time(0.95, ${selector('model_call')} | unwrap duration_ms [$__interval]) by (agent)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'ms',
});

const promptsPanel = panel({
  id: 8,
  type: 'bargauge',
  gridPos: { x: 0, y: 32, w: 12, h: 8 },
  title: 'Prompts per Session',
  description: 'Counts kind=prompt Events in the selected range, one bar per Session.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (count_over_time(${selector('prompt')} [$__range]))`,
    }),
  ],
  unit: 'short',
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
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

const wallTimePanel = panel({
  id: 9,
  type: 'histogram',
  gridPos: { x: 12, y: 32, w: 12, h: 8 },
  title: 'Session wall-time distribution',
  description:
    'The distribution of wall_ms taken from kind=run_end Events, one value per Session. Only a replayed or benched Session carries a run_end Event, so a Session recorded live without the Runner is absent from this panel.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{session_id}}',
      expr: `sum by (session_id) (sum_over_time(${selector('run_end')} | unwrap wall_ms [$__range]))`,
    }),
  ],
  unit: 'ms',
  custom: { fillOpacity: 80, lineWidth: 1 },
  options: {
    bucketOffset: 0,
    combine: true,
    legend: { showLegend: false, displayMode: 'list', placement: 'bottom', calcs: [] },
  },
});

export const sessionsDashboard: Dashboard = dashboard({
  uid: 'sessions',
  title: 'Sessions',
  variables,
  panels: [
    sessionsPanel,
    sessionsStartedPanel,
    modelCallsPanel,
    inputTokensPanel,
    outputTokensPanel,
    cacheReadSharePanel,
    latencyPanel,
    promptsPanel,
    wallTimePanel,
  ],
});

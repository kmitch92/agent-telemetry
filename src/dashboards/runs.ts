import type { Dashboard } from '../schema/dashboard.js';
import { dashboard, labelVariable, lokiTarget, panel, selector } from './lib.js';

/**
 * The Runs dashboard (SPEC.md's dashboards section): eight panels over
 * kind=run_end Events, all built from the shared selector in `./lib.ts` so
 * no panel ever hand-writes a stream selector.
 */

const SEL = selector('run_end');

const BARGAUGE_OPTIONS = {
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'horizontal',
  displayMode: 'gradient',
  showUnfilled: true,
  minVizHeight: 16,
  minVizWidth: 8,
  valueMode: 'color',
  namePlacement: 'auto',
  sizing: 'auto',
};

const variables = [
  labelVariable({ name: 'agent', label: 'Agent' }),
  labelVariable({ name: 'project', label: 'Project' }),
  labelVariable({ name: 'session_id', label: 'Session' }),
  labelVariable({ name: 'variant', label: 'Variant' }),
  labelVariable({ name: 'task', label: 'Task' }),
  labelVariable({ name: 'run_id', label: 'Run' }),
];

const passRateByVariantPanel = panel({
  id: 1,
  type: 'stat',
  gridPos: { x: 0, y: 0, w: 12, h: 8 },
  title: 'Pass rate by variant',
  description:
    'The share of kind=run_end Events with pass="true", grouped by variant. The `or (... * 0)` term reports a true zero for a variant with no passing Run, and no Event is fabricated.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{variant}}',
      expr: `(sum by (variant) (count_over_time(${SEL} | pass="true" [$__range])) or (sum by (variant) (count_over_time(${SEL} [$__range])) * 0)) / sum by (variant) (count_over_time(${SEL} [$__range]))`,
    }),
  ],
  unit: 'percentunit',
  decimals: 3,
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const passRatePerTaskAndVariantPanel = panel({
  id: 2,
  type: 'table',
  gridPos: { x: 12, y: 0, w: 12, h: 8 },
  title: 'Pass rate per task and variant',
  description:
    'The share of kind=run_end Events with pass="true", grouped by task and variant. The `or (... * 0)` term reports a true zero for a task-variant pair with no passing Run, and no Event is fabricated.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      expr: `(sum by (task, variant) (count_over_time(${SEL} | pass="true" [$__range])) or (sum by (task, variant) (count_over_time(${SEL} [$__range])) * 0)) / sum by (task, variant) (count_over_time(${SEL} [$__range]))`,
    }),
  ],
  unit: 'percentunit',
  custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false, filterable: true },
  options: {
    showHeader: true,
    cellHeight: 'sm',
    footer: { show: false, reducer: ['sum'], countRows: false, fields: '' },
  },
});

const turnsPerRunPanel = panel({
  id: 3,
  type: 'bargauge',
  gridPos: { x: 0, y: 8, w: 12, h: 8 },
  title: 'Turns per Run, by variant',
  description: 'The turns attribute on kind=run_end Events, one bar per run_id and variant.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{run_id}} ({{variant}})',
      expr: `max by (run_id, variant) (max_over_time(${SEL} | unwrap turns [$__range]))`,
    }),
  ],
  options: BARGAUGE_OPTIONS,
});

const wallTimePerRunPanel = panel({
  id: 4,
  type: 'bargauge',
  gridPos: { x: 12, y: 8, w: 12, h: 8 },
  title: 'Wall time per Run, by variant',
  description: 'The wall_ms attribute on kind=run_end Events, one bar per run_id and variant.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{run_id}} ({{variant}})',
      expr: `max by (run_id, variant) (max_over_time(${SEL} | unwrap wall_ms [$__range]))`,
    }),
  ],
  unit: 'ms',
  options: BARGAUGE_OPTIONS,
});

const inputTokensPerRunPanel = panel({
  id: 5,
  type: 'bargauge',
  gridPos: { x: 0, y: 16, w: 12, h: 8 },
  title: 'Input tokens per Run, by variant',
  description: 'The input_tokens attribute on kind=run_end Events, one bar per run_id and variant.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{run_id}} ({{variant}})',
      expr: `max by (run_id, variant) (max_over_time(${SEL} | unwrap input_tokens [$__range]))`,
    }),
  ],
  options: BARGAUGE_OPTIONS,
});

const toolCallsPerRunPanel = panel({
  id: 6,
  type: 'bargauge',
  gridPos: { x: 12, y: 16, w: 12, h: 8 },
  title: 'Tool calls per Run, by variant',
  description: 'The tool_calls attribute on kind=run_end Events, one bar per run_id and variant.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{run_id}} ({{variant}})',
      expr: `max by (run_id, variant) (max_over_time(${SEL} | unwrap tool_calls [$__range]))`,
    }),
  ],
  options: BARGAUGE_OPTIONS,
});

const timedOutRunsPanel = panel({
  id: 7,
  type: 'stat',
  gridPos: { x: 0, y: 24, w: 24, h: 6 },
  title: 'Timed-out Runs',
  description:
    'Counts kind=run_end Events with timed_out="true", by variant. The `or (... * 0)` term reports a true zero for a variant with no timed-out Run, and no Event is fabricated.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      legendFormat: '{{variant}}',
      expr: `sum by (variant) (count_over_time(${SEL} | timed_out="true" [$__range])) or (sum by (variant) (count_over_time(${SEL} [$__range])) * 0)`,
    }),
  ],
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
    orientation: 'auto',
    textMode: 'auto',
    colorMode: 'value',
    graphMode: 'none',
    justifyMode: 'auto',
  },
});

const runEndEventsPanel = panel({
  id: 8,
  type: 'table',
  gridPos: { x: 0, y: 30, w: 24, h: 10 },
  title: 'Run end Events',
  description:
    'One row per Run, newest first, read from kind=run_end Events: last event time, pass, turns, input tokens and wall time.',
  targets: [
    lokiTarget({
      refId: 'A',
      instant: true,
      expr: `max by (run_id, task, variant, agent) (max_over_time(${SEL} | unwrap observed_timestamp [$__range])) / 1000000`,
    }),
    lokiTarget({
      refId: 'B',
      instant: true,
      expr: `max by (run_id) (count_over_time(${SEL} | pass="true" [$__range])) or (max by (run_id) (count_over_time(${SEL} [$__range])) * 0)`,
    }),
    lokiTarget({
      refId: 'C',
      instant: true,
      expr: `max by (run_id) (max_over_time(${SEL} | unwrap turns [$__range]))`,
    }),
    lokiTarget({
      refId: 'D',
      instant: true,
      expr: `max by (run_id) (max_over_time(${SEL} | unwrap input_tokens [$__range]))`,
    }),
    lokiTarget({
      refId: 'E',
      instant: true,
      expr: `max by (run_id) (max_over_time(${SEL} | unwrap wall_ms [$__range]))`,
    }),
  ],
  custom: { align: 'auto', cellOptions: { type: 'auto' }, inspect: false, filterable: true },
  options: {
    showHeader: true,
    cellHeight: 'sm',
    footer: { show: false, reducer: ['sum'], countRows: false, fields: '' },
  },
  transformations: [
    { id: 'joinByField', options: { byField: 'run_id', mode: 'outer' } },
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
        },
        includeByName: {},
        indexByName: {
          run_id: 0,
          task: 1,
          variant: 2,
          agent: 3,
          'Value #A': 4,
          'Value #B': 5,
          'Value #C': 6,
          'Value #D': 7,
          'Value #E': 8,
        },
        renameByName: {
          'Value #A': 'Last Event',
          'Value #B': 'Pass',
          'Value #C': 'Turns',
          'Value #D': 'Input tokens',
          'Value #E': 'Wall ms',
        },
      },
    },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Last Event', desc: true }] } },
  ],
});

export const runsDashboard: Dashboard = dashboard({
  uid: 'runs',
  title: 'Runs',
  variables,
  panels: [
    passRateByVariantPanel,
    passRatePerTaskAndVariantPanel,
    turnsPerRunPanel,
    wallTimePerRunPanel,
    inputTokensPerRunPanel,
    toolCallsPerRunPanel,
    timedOutRunsPanel,
    runEndEventsPanel,
  ],
});

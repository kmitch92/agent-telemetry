import type { Dashboard, Transformation } from '../schema/dashboard.js';
import { TransformationSchema } from '../schema/dashboard.js';
import {
  dashboard,
  instantLokiTarget,
  labelVariable,
  liveSelector,
  lokiTarget,
  organizeTransformation,
  panel,
  valueMapping,
} from './lib.js';

/**
 * "Live, now": which Sessions are alive right now, and what state each one
 * is in. An exploration board, not a committed dashboard: twelve panels
 * over kind=model_call, kind=tool_call and every Event's own kind and
 * observed_timestamp, all built from `liveSelector` in `./lib.ts` so every
 * panel also respects the `$session_label` and `$branch` pickers. The user
 * keeps the panels that earn their place and drops the rest, so this
 * module favours variety of visualisation type over polish. Every panel
 * works with no live Session running: an empty panel in the 1-hour
 * default window is expected, not a failure, and every query also carries
 * data over a wider window such as 24 hours.
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
 * Most ALREADY STORED Events carry no `session_label` stream label
 * (SPEC's live dashboards section), so every panel that wants a readable
 * per-Session name falls back to the first 8 characters of `session_id`,
 * the same substitution `explore-activity.ts`'s `session_short` label uses
 * for the same reason. A Go template `if` on an absent label reads as an
 * empty string, so the fallback branch fires exactly when `session_label`
 * is unset.
 */
const SESSION_DISPLAY_STAGE =
  '| label_format session_display=`{{ if .session_label }}{{ .session_label }}{{ else }}{{ substr 0 8 .session_id }}{{ end }}`';

function liveSelectorDisplay(kind?: string): string {
  return `${liveSelector(kind)} ${SESSION_DISPLAY_STAGE}`;
}

/**
 * Converts an instant query's own `Time` field (the query's evaluation
 * instant, which Grafana sets to the dashboard's `to` time, effectively
 * "now" for a live 1-hour window) minus a `Value` field holding a Unix
 * millisecond timestamp, into a `seconds_since` field. Two chained
 * `calculateField` binary steps: `Time` minus `Value` in milliseconds,
 * then that result divided by the constant `1000`. LogQL itself has no
 * `time()` or `timestamp()` function (confirmed against this Stack's
 * Loki: both return a parse error). Safe only once `Time` and `Value`
 * already sit in one joined, table-shaped frame (`liveSessionsTablePanel`
 * below runs `joinByField` first for exactly this reason): calculateField
 * run directly against a per-Session grouped query, before any join,
 * reads a session_display-labelled `Value` field whose label is not a
 * column calculateField can see, confirmed against this Stack's Loki to
 * produce a wildly wrong figure, so every other "seconds since" panel on
 * this board now computes the same subtraction with the built-in Grafana
 * variable `$__to` inside the LogQL expression itself instead.
 */
function secondsSinceTransformations(timeField: string, valueField: string): Transformation[] {
  return [
    TransformationSchema.parse({
      id: 'calculateField',
      options: {
        mode: 'binary',
        binary: { left: timeField, operator: '-', right: valueField },
        alias: 'ms_since',
      },
    }),
    TransformationSchema.parse({
      id: 'calculateField',
      options: {
        mode: 'binary',
        binary: { left: 'ms_since', operator: '/', right: '1000' },
        alias: 'seconds_since',
        replaceFields: false,
      },
    }),
  ];
}

// --- The spine -------------------------------------------------------------

const liveSessionsTablePanel = panel({
  id: 1,
  type: 'table',
  gridPos: { x: 0, y: 0, w: 24, h: 10 },
  title: 'Live sessions',
  description:
    'One row per Session with an Event in the selected window: its label (session_label, or ' +
    'the first 8 characters of session_id when session_label is absent), seconds since its ' +
    'last Event, model calls so far, tool calls so far, and the model it called most recently ' +
    '(sum by session_id and model, so a Session that calls more than one model shows one row ' +
    "per model it used). Seconds since last event is the query's own evaluation instant minus " +
    'the last observed_timestamp, computed in two calculateField steps because LogQL has no ' +
    'time() function.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `max_over_time(${liveSelectorDisplay()} | unwrap observed_timestamp [$__range]) by (session_id, session_display) / 1000000`,
    }),
    instantLokiTarget({
      refId: 'B',
      expr: `sum by (session_id) (count_over_time(${liveSelector('model_call')} [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'C',
      expr: `sum by (session_id) (count_over_time(${liveSelector('tool_call')} [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'D',
      expr: `sum by (session_id, model) (count_over_time(${liveSelector('model_call')} [$__range]))`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'joinByField', options: { byField: 'session_id', mode: 'outer' } },
    ...secondsSinceTransformations('Time 1', 'Value #A'),
    organizeTransformation({
      order: ['session_display', 'seconds_since', 'Value #B', 'Value #C', 'model'],
      rename: {
        'Value #B': 'model calls',
        'Value #C': 'tool calls',
        seconds_since: 'seconds since last event',
      },
      exclude: [
        'session_id',
        'Time 1',
        'Time 2',
        'Time 3',
        'Time 4',
        'Value #A',
        'Value #D',
        'ms_since',
      ],
    }),
    {
      id: 'sortBy',
      options: { fields: {}, sort: [{ field: 'seconds since last event', desc: false }] },
    },
  ],
  overrides: [
    {
      matcher: { id: 'byName', options: 'seconds since last event' },
      properties: [{ id: 'unit', value: 's' }],
    },
  ],
});

// --- Headline counts ---------------------------------------------------

const activeSessionsNowPanel = panel({
  id: 2,
  type: 'stat',
  gridPos: { x: 0, y: 10, w: 8, h: 6 },
  title: 'Active sessions, right now',
  description:
    'Counts the distinct session_id values with at least one Event in the selected window. Zero ' +
    'is a genuine count, shown rather than "No data", because count() over zero matching Sessions ' +
    'is itself the real answer. The inner aggregation is `sum by`, not `count by`: a direct ' +
    "query against this Stack's Loki confirmed `count by (session_id) (count_over_time(...))` " +
    'raises "maximum of series (500) reached for a single query" over a wide window on this ' +
    'exact dataset, where the structurally identical `sum by (session_id)` does not, so the sum ' +
    'form is used and the outer count() still counts one entry per distinct session_id.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `count(sum by (session_id) (count_over_time(${liveSelector()} [$__range])))`,
    }),
  ],
  unit: 'short',
  noValue: '0',
  options: STAT_OPTIONS,
});

const sessionStateWordsPanel = panel({
  id: 5,
  type: 'stat',
  gridPos: { x: 8, y: 10, w: 8, h: 6 },
  title: 'Session state, in words, top 10',
  description:
    'One tile per Session with an Event in the selected window, limited to the top 10 by that ' +
    'same working/idle value (so a working Session always sorts ahead of an idle one): 1 when ' +
    'that Session has an Event in the trailing 1 minute, 0 otherwise, mapped through ' +
    'valueMapping to "working" or "idle". A Session count in the low twenties drew one tile per ' +
    'Session, each too small to read its own label; topk(10, ...) keeps the panel at its ' +
    "original size (so it still lines up with its row's two sibling stat panels) while cutting " +
    'the tile count enough to read each label. The `or (... * 0)` term reports a true 0 for a ' +
    'Session that is in the window but quiet right now, rather than dropping it, and no Event ' +
    'is fabricated.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `topk(10, (sum by (session_display) (count_over_time(${liveSelectorDisplay()} [1m])) > bool 0) or (sum by (session_display) (count_over_time(${liveSelectorDisplay()} [$__range])) * 0))`,
    }),
  ],
  unit: 'short',
  mappings: [valueMapping({ '0': 'idle', '1': 'working' })],
  options: { ...STAT_OPTIONS, reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true } },
});

const longestActiveSessionPanel = panel({
  id: 10,
  type: 'stat',
  gridPos: { x: 16, y: 10, w: 8, h: 6 },
  title: 'Longest-running session in view, time since first event',
  description:
    'Was "Longest continuously active session": the largest gap between a Session\'s first and ' +
    'last observed_timestamp in the selected window. A direct query against this exact ' +
    "expression confirmed it measured 0.074 s (74 ms) for this Stack's busiest Session, because " +
    "every stored Session's observed_timestamp values land within milliseconds of each other, " +
    'not spread across the Session\'s real duration, so "first minus last" can never read in ' +
    'hours for the data this Stack holds. This panel now reports, among Sessions with at least ' +
    "one Event in the selected window, the longest elapsed time since that Session's earliest " +
    'Event ($__to, the built-in Grafana end-of-range variable, in Unix milliseconds, minus the ' +
    'earliest observed_timestamp, converted from nanoseconds), the same $__to-minus-' +
    'observed_timestamp arithmetic already proven correct on the Live: trouble board. noValue ' +
    'reads 0 when no Session has an Event in the window at all.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      expr: `topk(1, $__to - (min by (session_display) (min_over_time(${liveSelectorDisplay()} | unwrap observed_timestamp [$__range])) / 1000000)) / 1000`,
    }),
  ],
  unit: 's',
  noValue: '0',
  options: STAT_OPTIONS,
});

// --- Shape of activity ---------------------------------------------------

const sessionActivityStateTimelinePanel = panel({
  id: 3,
  type: 'state-timeline',
  gridPos: { x: 0, y: 16, w: 24, h: 10 },
  title: 'Session activity, working against idle',
  description:
    'One row per Session, the top 20 by Event count in the selected window: 1 ("working") in ' +
    'every $__interval bucket that holds at least one Event, nothing drawn for a bucket with no ' +
    'Event, since LogQL has no way to report a true 0 at a specific time bucket without ' +
    'fabricating an Event. A gap in a row is a bucket with no Event, closer to "idle" than to ' +
    '"working", but it is drawn as a gap, not coloured idle, so no value is invented.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `topk(20, (sum by (session_display) (count_over_time(${liveSelectorDisplay()} [$__interval]))) > bool 0)`,
    }),
  ],
  custom: {},
  mappings: [valueMapping({ '1': 'working' })],
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

const secondsSinceLastEventPanel = panel({
  id: 4,
  type: 'barchart',
  gridPos: { x: 0, y: 26, w: 12, h: 8 },
  title: 'Seconds since last event, by session',
  description:
    'For each Session with an Event in the selected window, $__to (the built-in Grafana ' +
    'end-of-range variable, in Unix milliseconds) minus its last observed_timestamp (converted ' +
    'from nanoseconds), in seconds, so a stalled Session stands out with a tall bar. The ' +
    'subtraction is computed inside the LogQL expression itself, the same $__to arithmetic ' +
    'already proven correct on the Live: trouble board, rather than through a calculateField ' +
    'transformation: a per-session grouped query returns one frame per Session with its label ' +
    'carried as metadata rather than a plain column, and calculateField run without first ' +
    'joining those frames back together produced a wildly wrong figure (confirmed against this ' +
    "Stack's Loki: thousands of years instead of hours), so the arithmetic now happens where the " +
    'label and the value are still one query result. Drawn as a horizontal `barchart`, not a ' +
    '`bargauge`: a `bargauge` fed by a query that narrows to one series hides its label, a fault ' +
    'already hit and fixed the same way on the Explore: activity and Explore: latency boards.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `($__to - (max_over_time(${liveSelectorDisplay()} | unwrap observed_timestamp [$__range]) by (session_display) / 1000000)) / 1000`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 's',
});

const eventsPerSecondBySessionPanel = panel({
  id: 6,
  type: 'timeseries',
  gridPos: { x: 12, y: 26, w: 12, h: 8 },
  title: 'Events per second, by session',
  description:
    'Every kind of Event, counted in each $__interval bucket and divided by the bucket length in ' +
    'seconds, one series per Session, so the rhythm of a Session (steady, bursty, or silent) is ' +
    'visible over the selected window.',
  targets: [
    lokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `sum by (session_display) (count_over_time(${liveSelectorDisplay()} [$__interval])) / ($__interval_ms / 1000)`,
    }),
  ],
  custom: SHARED_LINE_STYLE,
  options: SHARED_TIMESERIES_OPTIONS,
  unit: 'short',
});

// --- Who is active ---------------------------------------------------------

const activeByProjectPanel = panel({
  id: 8,
  type: 'piechart',
  gridPos: { x: 0, y: 34, w: 12, h: 8 },
  title: 'Active sessions, by project',
  description:
    'Counts the distinct session_id values with at least one Event in the selected window, ' +
    'grouped by project. reduceOptions.values is true because an instant Loki query returns one ' +
    'table-shaped frame with project as a string column and Value as the numeric column, one row ' +
    'per series, so the panel needs one slice per row, the same reason toolTypeSplitPanel on the ' +
    'Explore: activity board sets it.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{project}}',
      expr: `count by (project) (sum by (session_id, project) (count_over_time(${liveSelector()} [$__range])))`,
    }),
  ],
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
    pieType: 'pie',
    displayLabels: ['name', 'value'],
    legend: { showLegend: true, displayMode: 'list', placement: 'right', calcs: [] },
    tooltip: { mode: 'single', sort: 'none' },
  },
  unit: 'short',
});

const activeByBranchPanel = panel({
  id: 9,
  type: 'barchart',
  gridPos: { x: 12, y: 34, w: 12, h: 8 },
  title: 'Active sessions, by branch',
  description:
    'Counts the distinct session_id values with at least one Event in the selected window, ' +
    'grouped by branch, as a horizontal bar chart rather than a pie, for a second visualisation ' +
    'of the same split the project panel above draws. A label_format step renames an empty ' +
    'branch to the literal "none" before grouping, the same fix allKindsOverTimePanel on the ' +
    'Explore: activity board applies to an empty kind, because an empty branch interpolates to ' +
    'an empty legend name and draws as a blank bar label.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{branch}}',
      expr: `count by (branch) (sum by (session_id, branch) (count_over_time(${liveSelector()} | label_format branch=\`{{ if .branch }}{{ .branch }}{{ else }}none{{ end }}\` [$__range])))`,
    }),
  ],
  custom: HORIZONTAL_BARCHART_CUSTOM,
  options: HORIZONTAL_BARCHART_OPTIONS,
  unit: 'short',
});

const modelVsToolCallsPanel = panel({
  id: 11,
  type: 'barchart',
  gridPos: { x: 0, y: 42, w: 24, h: 8 },
  title: 'Model calls against tool calls, by session',
  description:
    'For each Session with an Event in the selected window, the count of kind=model_call Events ' +
    'against the count of kind=tool_call Events, two bars per Session, so a Session doing mostly ' +
    'tool work stands out against one doing mostly model calls.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `sum by (session_display) (count_over_time(${liveSelectorDisplay('model_call')} [$__range]))`,
    }),
    instantLokiTarget({
      refId: 'B',
      legendFormat: '{{session_display}}',
      expr: `sum by (session_display) (count_over_time(${liveSelectorDisplay('tool_call')} [$__range]))`,
    }),
  ],
  options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] } },
  transformations: [
    { id: 'joinByField', options: { byField: 'session_display', mode: 'outer' } },
    organizeTransformation({
      order: ['session_display', 'Value #A', 'Value #B'],
      rename: { 'Value #A': 'model calls', 'Value #B': 'tool calls' },
      exclude: ['Time 1', 'Time 2'],
    }),
  ],
  unit: 'short',
});

// --- Not active now ---------------------------------------------------------

const stoppedSessionsTodayPanel = panel({
  id: 7,
  type: 'table',
  gridPos: { x: 0, y: 50, w: 24, h: 8 },
  title: 'Sessions seen today, not active now',
  description:
    "Sessions with at least one Event in the last 24 hours, minus (LogQL's `unless` set " +
    'operator) every Session with an Event in the selected window, so only a Session that has ' +
    'genuinely gone quiet remains, with how long ago (in seconds) its last Event was: $__to (the ' +
    "built-in Grafana end-of-range variable, in Unix milliseconds) minus that Event's " +
    'observed_timestamp, computed inside the LogQL expression itself. The arithmetic moved into ' +
    "LogQL, and labelsToFields plus merge now turn each Session's session_display label into an " +
    'actual table column before the rows are combined: this panel read "No data" at a 1-hour ' +
    'range because the query returns one frame per Session with session_display carried as ' +
    'frame metadata rather than a column, and a table fed many single-row, single-column frames ' +
    'with nothing in common to join on renders nothing, confirmed by a direct query against this ' +
    "exact expression, which returned real data at the Loki level throughout. This panel's own " +
    '"today" window is a fixed 24 hours, independent of the dashboard\'s own default range, ' +
    'since a Session stopped 2 hours ago would otherwise never appear.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `(($__to - (max_over_time(${liveSelectorDisplay()} | unwrap observed_timestamp [24h]) by (session_display) / 1000000)) / 1000) unless (sum by (session_display) (count_over_time(${liveSelectorDisplay()} [$__range])) * 0)`,
    }),
  ],
  custom: TABLE_CUSTOM,
  options: TABLE_OPTIONS,
  transformations: [
    { id: 'labelsToFields', options: {} },
    { id: 'merge', options: {} },
    organizeTransformation({
      order: ['session_display', 'Value'],
      rename: { Value: 'stopped, seconds ago' },
      exclude: ['Time'],
    }),
    {
      id: 'sortBy',
      options: { fields: {}, sort: [{ field: 'stopped, seconds ago', desc: false }] },
    },
  ],
  overrides: [
    {
      matcher: { id: 'byName', options: 'stopped, seconds ago' },
      properties: [{ id: 'unit', value: 's' }],
    },
  ],
});

// --- Exploratory scatter ----------------------------------------------------

const modelCallsAgainstIdleTimePanel = panel({
  id: 12,
  type: 'trend',
  gridPos: { x: 0, y: 58, w: 24, h: 8 },
  title: 'Sessions ranked by seconds since last event',
  description:
    'Was "Model calls so far against seconds since last event": model calls on the x axis drew a ' +
    'flat line repeating one value, because most stored Sessions share the same model-call ' +
    'count (often 0 in a narrow window), so the groupBy step collapsed nearly every Session into ' +
    'one x bucket. A direct query against the surviving y-axis expression confirmed the repeated ' +
    'figure itself was correct (the genuine seconds-since-last-event most stale Sessions share), ' +
    'so the fix is the x field, not the arithmetic. $__to (the built-in Grafana end-of-range ' +
    "variable) minus each Session's last observed_timestamp gives seconds since last event " +
    'directly in LogQL; labelsToFields turns the session_display label into a column, sortBy ' +
    "orders Sessions from most to least idle, and calculateField's index mode then adds each " +
    "row's position as a `rank` field: a plain row count, so it is always unique and ascending " +
    'regardless of how many Sessions share the same seconds-since value, the one property a ' +
    '`trend` panel needs from its x field. A `trend` panel, not `xychart`: the xychart plugin ' +
    'does not load in this Grafana image.',
  targets: [
    instantLokiTarget({
      refId: 'A',
      legendFormat: '{{session_display}}',
      expr: `($__to - (max_over_time(${liveSelectorDisplay()} | unwrap observed_timestamp [$__range]) by (session_display) / 1000000)) / 1000`,
    }),
  ],
  transformations: [
    { id: 'labelsToFields', options: {} },
    { id: 'sortBy', options: { fields: {}, sort: [{ field: 'Value', desc: true }] } },
    {
      id: 'calculateField',
      options: { mode: 'index', alias: 'rank', replaceFields: false },
    },
    organizeTransformation({
      order: ['rank', 'Value'],
      rename: { Value: 'seconds_since' },
      exclude: ['Time', 'session_display'],
    }),
  ],
  custom: SCATTER_POINT_STYLE,
  options: { xFieldName: 'rank', ...SHARED_TIMESERIES_OPTIONS },
  unit: 's',
});

export const liveNowDashboard: Dashboard = dashboard({
  uid: 'live-now',
  title: 'Live, now',
  variables,
  // Confirmed against a live Grafana 11.6.16: the newest stored Event is
  // about 20 hours old, so the 15-minute default left the board looking
  // empty until a Session happened to be running at that exact moment.
  time: { from: 'now-1h', to: 'now' },
  refresh: '5s',
  timepicker: { refresh_intervals: ['5s', '10s'] },
  panels: [
    liveSessionsTablePanel,
    activeSessionsNowPanel,
    sessionActivityStateTimelinePanel,
    secondsSinceLastEventPanel,
    sessionStateWordsPanel,
    eventsPerSecondBySessionPanel,
    stoppedSessionsTodayPanel,
    activeByProjectPanel,
    activeByBranchPanel,
    longestActiveSessionPanel,
    modelVsToolCallsPanel,
    modelCallsAgainstIdleTimePanel,
  ],
});

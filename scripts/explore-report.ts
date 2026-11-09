import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DashboardSchema } from '../src/schema/dashboard.js';
import { extractTargets, substituteQuery, type PanelTarget } from '../src/smoke/index.js';

/**
 * `npx tsx scripts/explore-report.ts`: a review aid for the three
 * exploration dashboards under `compose/grafana/dashboards/explore-*.json`
 * (SPEC.md's dashboards section). Earlier versions of this script asked
 * Loki directly whether a panel's query returned a series, which is too
 * weak a check: Loki can return a series that Grafana still cannot draw
 * ("Data is missing a number field", "Only one frame is supported,
 * consider adding a join transformation", an unlabelled bar from a raw
 * label set). This version asks Grafana's own datasource proxy
 * (`POST /api/ds/query`) for each panel's query, the same endpoint the
 * Grafana UI itself uses, and inspects the returned data frames the way
 * Grafana would: field types, field names, row counts, and frame counts.
 * This is a report, not a gate: an exploration panel may legitimately
 * return no data, so this script always exits 0 and never writes to a
 * dashboard file. It reuses `extractTargets` and `substituteQuery` from
 * `../src/smoke/index.js` rather than re-implementing either of them.
 */

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DASHBOARDS_DIR = join(REPO_ROOT, 'compose', 'grafana', 'dashboards');
const EXPLORE_FILES = ['explore-latency.json', 'explore-tokens.json', 'explore-activity.json'];
const WINDOW_MS = 86_400_000; // the last 24 hours, as this report's SPEC requires.
const FETCH_TIMEOUT_MS = 10_000;
const GRAFANA_BASE_URL = process.env['SMOKE_GRAFANA_URL'] ?? 'http://localhost:3000';
const GRAFANA_QUERY_URL = `${GRAFANA_BASE_URL}/api/ds/query`;

/**
 * SPEC's six panel outcomes. `MANY_FRAMES` is this report's own addition
 * on top of SPEC's five-level rank order (see `worseOf` below): SPEC
 * assigns it only to a `trend` panel that gets more than one frame back,
 * since Grafana's trend panel can draw exactly one frame
 * ("Only one frame is supported, consider adding a join transformation").
 * Every other panel type keeps its `DATA` outcome when it gets more than
 * one frame; the frame count is printed as information, not a failure.
 */
type Outcome = 'ERROR' | 'NO_NUMBER' | 'UNNAMED' | 'MANY_FRAMES' | 'EMPTY' | 'DATA';

interface PanelResult {
  panelIndex: number;
  panelType: string;
  panelTitle: string;
  outcome: Outcome;
  transformationCount: number;
  detail?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The shape of one data frame in Grafana's `/api/ds/query` response, down
 * to the fields this report reads: a field's `type` (`"number"`, `"time"`,
 * `"string"`, `"other"`), its `name` (always the literal `"Value"` or
 * `"Time"` for a Loki metric query), and, when Grafana names a series
 * after its labels or a `legendFormat`, `config.displayNameFromDS`.
 * Confirmed against a live Grafana instance: a metric query with no
 * `legendFormat` returns `displayNameFromDS` as a raw label set such as
 * `"{mcp_server_target=\"billing.lookup_invoice\"}"`, or as the literal
 * `"{}"` when the query groups by nothing; a `legendFormat` of
 * `"{{mcp_server_target}}"` returns the interpolated, readable string
 * instead. A raw log-line query (a table or an xychart panel's usual
 * shape) returns fields named `labels`, `Time`, `Line`, `tsNs`,
 * `labelTypes`, `id`, none of them `type: "number"`, which is the
 * condition behind Grafana's "Data is missing a number field".
 */
const GrafanaFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  config: z
    .object({
      displayNameFromDS: z.string().optional(),
    })
    .optional(),
});

const GrafanaFrameSchema = z.object({
  schema: z.object({
    fields: z.array(GrafanaFieldSchema),
  }),
  data: z.object({
    values: z.array(z.array(z.unknown())),
  }),
});

type GrafanaFrame = z.infer<typeof GrafanaFrameSchema>;
type GrafanaField = z.infer<typeof GrafanaFieldSchema>;

/**
 * One query's result inside the `results` map, keyed by `refId`. A
 * request that Grafana rejects outright, confirmed live against
 * `{bad syntax` as an `expr`, comes back as HTTP 400 with a body this
 * schema still parses: `results.A.error` carries the parse error and
 * `results.A.status` carries `500`, with no `frames` key at all. A query
 * that matches nothing also carries no `frames` key.
 */
const GrafanaQueryResultSchema = z.object({
  status: z.number().optional(),
  error: z.string().optional(),
  errorSource: z.string().optional(),
  frames: z.array(GrafanaFrameSchema).optional(),
});

const GrafanaDsQueryResponseSchema = z.object({
  results: z.record(z.string(), GrafanaQueryResultSchema),
});

/**
 * `substituteQuery` (from the read-only `../src/smoke/index.js`) replaces
 * Grafana's `$__range` macro with a fixed `'1h'`, a value sized for that
 * module's own smoke check, not for this report's 24-hour `WINDOW_MS`.
 * Confirmed live with curl against `/api/ds/query`: an instant query is
 * evaluated at one instant, so with `$__range` fixed at `'1h'` every
 * `[$__range]` log-range selector looks back only one hour from the query
 * time. The failing body below returns `{"results":{"A":{"status":200}}}`,
 * no `frames` key at all, which this report classifies as `EMPTY`:
 *   expr: `...count_over_time({...} | kind="tool_call" [1h])...`
 * The working body differs only in the selector's duration, matching the
 * 24-hour range the live dashboard actually renders with:
 *   expr: `...count_over_time({...} | kind="tool_call" [24h])...`
 * which returns two populated frames (`tool_type="mcp"` at 121,
 * `tool_type="native"` at 9526). Confirmed by inspecting every panel
 * target in all three dashboards that no range-type target uses
 * `$__range` (only instant targets do), so this report pre-substitutes
 * `$__range` to a duration matching its own `WINDOW_MS` before handing the
 * expression to `substituteQuery`: by the time that function's own
 * hardcoded replacement runs, the `$__range` token is already gone, so
 * its replacement becomes a no-op and the correct window survives.
 */
const RANGE_MACRO_PATTERN = /\$\{__range\}|\$__range(?![A-Za-z0-9_])/g;

/** A Loki duration string for `windowMs`, in whole hours when exact, else seconds. */
function formatRangeDuration(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  return Number.isInteger(hours) ? `${String(hours)}h` : `${String(windowMs / 1000)}s`;
}

/** Replaces `$__range`/`${__range}` with a duration matching `windowMs`, ahead of `substituteQuery`. */
function preSubstituteRange(expr: string, windowMs: number): string {
  return expr.replace(RANGE_MACRO_PATTERN, formatRangeDuration(windowMs));
}

/**
 * `PanelTarget` (from the read-only `../src/smoke/index.js`) carries no
 * `legendFormat`, because the smoke check it was built for never needs
 * one. This report does: confirmed live, Grafana's Loki backend plugin
 * interpolates a query's `legendFormat` into `displayNameFromDS`
 * server-side, so the real dashboard, whose panel JSON does carry a
 * `legendFormat`, sends it to Grafana when it renders. Omitting it here
 * would report `UNNAMED` for a panel the live dashboard renders with a
 * readable name, so `reportDashboard` reads `legendFormat` straight off
 * the parsed dashboard JSON it already holds and passes it in here.
 */
function buildRequestBody(
  target: PanelTarget,
  endMs: number,
  windowMs: number,
  legendFormat: string | undefined,
): unknown {
  return {
    queries: [
      {
        refId: target.refId,
        datasource: { type: target.datasourceType, uid: target.datasourceUid },
        expr: target.expr,
        queryType: target.instant ? 'instant' : 'range',
        ...(legendFormat !== undefined ? { legendFormat } : {}),
      },
    ],
    from: String(endMs - windowMs),
    to: String(endMs),
  };
}

function frameHasRow(frame: GrafanaFrame): boolean {
  return frame.data.values.some((column) => column.length > 0);
}

/** `displayNameFromDS` when Grafana set one, else the field's own `name`. */
function readableFieldName(field: GrafanaField): string | undefined {
  const fromDs = field.config?.displayNameFromDS;
  return fromDs !== undefined && fromDs.length > 0 ? fromDs : field.name;
}

/** A raw Loki label set such as `{agent="claude-code"}`, including the empty `{}`. */
function isRawLabelSet(name: string): boolean {
  return /^\{.*\}$/.test(name);
}

/** The condition behind an unlabelled bar: SPEC's three unreadable-name cases. */
function isUnreadableName(name: string | undefined): boolean {
  return name === undefined || name.length === 0 || name === 'Value' || isRawLabelSet(name);
}

/**
 * Panel types that draw one visual series per value (a bar, a slice, a
 * line, a row), so a series with no readable name draws as an unlabelled
 * bar, slice, or line. `UNNAMED` is only ever a real fault for these.
 */
const NAME_BEARING_PANEL_TYPES = new Set([
  'barchart',
  'bargauge',
  'piechart',
  'timeseries',
  'trend',
  'state-timeline',
  'status-history',
  'xychart',
  'table',
]);

/**
 * Panel types that reduce every value to a single displayed number and
 * never draw a series name at all (Grafana's stat and gauge panels show
 * only the number). `UNNAMED` can never be a real fault for these, so they
 * are exempted even though Grafana still returns an unreadable field name
 * such as `"{}"` for them.
 */
const SINGLE_VALUE_PANEL_TYPES = new Set(['stat', 'gauge']);

/**
 * Whether an unreadable value field name is a real fault for this panel
 * type. A single-value panel is exempted outright; a name-bearing panel
 * still needs more than one frame before an unreadable name matters,
 * because with exactly one frame nothing distinguishes one series from
 * another, so no name is needed to tell them apart.
 */
function panelNeedsSeriesName(panelType: string): boolean {
  if (SINGLE_VALUE_PANEL_TYPES.has(panelType)) {
    return false;
  }
  return NAME_BEARING_PANEL_TYPES.has(panelType);
}

interface FrameClassification {
  outcome: 'NO_NUMBER' | 'UNNAMED' | 'DATA';
  detail?: string;
}

/**
 * Classifies one target's frames the way Grafana would try to draw them:
 * no frame carrying a row is `EMPTY`; a row-carrying frame with no
 * `type: "number"` field is `NO_NUMBER`; otherwise `DATA`, unless this
 * panel type needs a series name (`panelNeedsSeriesName`) and got more
 * than one row-carrying frame back, in which case a numeric field with an
 * unreadable name is `UNNAMED`. `NO_NUMBER` is checked across every
 * row-carrying frame before `UNNAMED` is checked across any of them, so a
 * target with one bad frame and one good frame still reports its worst
 * case.
 */
function classifyFrames(
  frames: readonly GrafanaFrame[],
  panelType: string,
): FrameClassification | { outcome: 'EMPTY' } {
  const withRows = frames.filter(frameHasRow);
  if (withRows.length === 0) {
    return { outcome: 'EMPTY' };
  }

  for (const frame of withRows) {
    const numericFields = frame.schema.fields.filter((field) => field.type === 'number');
    if (numericFields.length === 0) {
      return { outcome: 'NO_NUMBER', detail: 'no field in the frame has a numeric type' };
    }
  }

  if (panelNeedsSeriesName(panelType) && withRows.length > 1) {
    for (const frame of withRows) {
      const numericFields = frame.schema.fields.filter((field) => field.type === 'number');
      for (const field of numericFields) {
        const name = readableFieldName(field);
        if (isUnreadableName(name)) {
          const shown = name === undefined ? 'absent' : JSON.stringify(name);
          return { outcome: 'UNNAMED', detail: `value field name is ${shown}` };
        }
      }
    }
  }

  return { outcome: 'DATA' };
}

interface TargetOutcome {
  outcome: Outcome;
  detail?: string;
  frameCount: number;
}

/**
 * Runs one target's query against Grafana's own datasource proxy
 * (`POST /api/ds/query`, confirmed live: Grafana runs with anonymous Admin
 * access, so no credentials are sent) and classifies the result. A
 * network failure, an unparsable body, a missing result for this target's
 * `refId`, or a `results[refId].error` is `ERROR`; otherwise the frames
 * are classified by `classifyFrames`.
 */
async function runTarget(
  target: PanelTarget,
  endMs: number,
  windowMs: number,
  legendFormat: string | undefined,
  panelType: string,
): Promise<TargetOutcome> {
  let response: Response;
  try {
    response = await fetch(GRAFANA_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequestBody(target, endMs, windowMs, legendFormat)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return { outcome: 'ERROR', detail: `request failed: ${describeError(error)}`, frameCount: 0 };
  }

  let rawBody: unknown;
  try {
    rawBody = await response.json();
  } catch (error) {
    return {
      outcome: 'ERROR',
      detail: `http ${String(response.status)}, unparsable response: ${describeError(error)}`,
      frameCount: 0,
    };
  }

  const parsed = GrafanaDsQueryResponseSchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      outcome: 'ERROR',
      detail: `http ${String(response.status)}, unparsable response: ${parsed.error.message}`,
      frameCount: 0,
    };
  }

  const result = parsed.data.results[target.refId];
  if (result === undefined) {
    return {
      outcome: 'ERROR',
      detail: `http ${String(response.status)}, no result for refId ${target.refId}`,
      frameCount: 0,
    };
  }

  if (result.error !== undefined) {
    const detail =
      result.errorSource !== undefined ? `${result.error} (${result.errorSource})` : result.error;
    return { outcome: 'ERROR', detail, frameCount: 0 };
  }

  const frames = result.frames ?? [];
  return { ...classifyFrames(frames, panelType), frameCount: frames.length };
}

/**
 * SPEC item 2's `MANY_FRAMES` rule. Only a target that already classified
 * as `DATA` is eligible: `EMPTY`, `NO_NUMBER` and `UNNAMED` are worse
 * outcomes already and are printed as they are regardless of frame count.
 * A `trend` panel with more than one frame is a real fault, so it becomes
 * `MANY_FRAMES`; every other panel type keeps `DATA` and gets the frame
 * count noted as information.
 */
function applyManyFrames(result: TargetOutcome, panelType: string): TargetOutcome {
  if (result.outcome !== 'DATA' || result.frameCount <= 1) {
    return result;
  }

  if (panelType === 'trend') {
    return {
      outcome: 'MANY_FRAMES',
      detail: `${String(result.frameCount)} frames`,
      frameCount: result.frameCount,
    };
  }

  return { ...result, detail: `info: ${String(result.frameCount)} frames` };
}

/**
 * Worst to best, per SPEC: `ERROR`, `NO_NUMBER`, `UNNAMED`, `EMPTY`,
 * `DATA`. `MANY_FRAMES` sits between `UNNAMED` and `EMPTY`: this report
 * only ever assigns it to a `trend` panel's otherwise-`DATA` target (see
 * `applyManyFrames`), so a real multi-frame rendering fault outranks a
 * legitimately empty panel, but SPEC's own five-level order never needs
 * to place it, because outside a `trend` panel this report never assigns
 * it.
 */
const RANK: Record<Outcome, number> = {
  ERROR: 5,
  NO_NUMBER: 4,
  UNNAMED: 3,
  MANY_FRAMES: 2,
  EMPTY: 1,
  DATA: 0,
};

function worseOf(a: Outcome, b: Outcome): Outcome {
  return RANK[b] > RANK[a] ? b : a;
}

interface PanelMeta {
  index: number;
  type: string;
  title: string;
  transformationCount: number;
}

/**
 * Folds one more target's outcome into a panel's running result. A panel
 * with more than one target (`refId` A, B, C, ...) is reported by its
 * worst-case target, and the detail line that first produced that worst
 * outcome is the "most informative line" this report prints for the panel.
 */
function mergeResult(
  prev: PanelResult | undefined,
  meta: PanelMeta,
  next: { outcome: Outcome; detail?: string },
): PanelResult {
  if (prev !== undefined && worseOf(prev.outcome, next.outcome) === prev.outcome) {
    return prev;
  }

  return {
    panelIndex: meta.index,
    panelType: meta.type,
    panelTitle: meta.title,
    outcome: prev === undefined ? next.outcome : worseOf(prev.outcome, next.outcome),
    transformationCount: meta.transformationCount,
    ...(next.detail !== undefined ? { detail: next.detail } : {}),
  };
}

async function reportDashboard(file: string, endMs: number): Promise<PanelResult[]> {
  const raw = await readFile(join(DASHBOARDS_DIR, file), 'utf8');
  const parsedJson: unknown = JSON.parse(raw);
  const dashboard = DashboardSchema.parse(parsedJson);
  const targets = extractTargets({ file, dashboard: parsedJson });
  const variables = dashboard.templating.list;

  const panelMeta = new Map<string, PanelMeta>();
  const legendFormatByKey = new Map<string, string>();
  dashboard.panels.forEach((p, index) => {
    panelMeta.set(p.title, {
      index,
      type: p.type,
      title: p.title,
      transformationCount: p.transformations?.length ?? 0,
    });
    for (const panelTarget of p.targets) {
      if (panelTarget.legendFormat !== undefined) {
        legendFormatByKey.set(`${p.title}::${panelTarget.refId}`, panelTarget.legendFormat);
      }
    }
  });

  const results = new Map<string, PanelResult>();

  for (const target of targets) {
    const meta = panelMeta.get(target.panelTitle);
    if (meta === undefined) {
      continue;
    }

    const exprWithRange = target.instant ? preSubstituteRange(target.expr, WINDOW_MS) : target.expr;
    const query = substituteQuery({ expr: exprWithRange, variables });
    const legendFormat = legendFormatByKey.get(`${target.panelTitle}::${target.refId}`);
    const raw2 = await runTarget(
      { ...target, expr: query },
      endMs,
      WINDOW_MS,
      legendFormat,
      meta.type,
    );
    const next = applyManyFrames(raw2, meta.type);
    results.set(target.panelTitle, mergeResult(results.get(target.panelTitle), meta, next));
  }

  return [...results.values()].sort((a, b) => a.panelIndex - b.panelIndex);
}

function emptyCounts(): Record<Outcome, number> {
  return { ERROR: 0, NO_NUMBER: 0, UNNAMED: 0, MANY_FRAMES: 0, EMPTY: 0, DATA: 0 };
}

function addCounts(target: Record<Outcome, number>, source: Record<Outcome, number>): void {
  for (const outcome of Object.keys(target) as Outcome[]) {
    target[outcome] += source[outcome];
  }
}

function formatCounts(counts: Record<Outcome, number>): string {
  return (Object.keys(counts) as Outcome[])
    .map((outcome) => `${outcome} ${String(counts[outcome])}`)
    .join(', ');
}

/**
 * SPEC's advisory rule (the review aid's third fix): a panel transformation
 * such as `extractFields`, `convertFieldType`, `organize` or `joinByField`
 * runs later, in the browser, after this script's backend-only query has
 * already been classified. A panel that declares one or more
 * transformations and whose outcome is not `DATA` is marked advisory
 * rather than a real fault, because the browser-side transformation may
 * still turn its raw frames into a valid render this script never sees. A
 * panel with no transformations keeps its outcome as a real fault,
 * unchanged.
 */
function isAdvisory(result: PanelResult): boolean {
  return result.transformationCount > 0 && result.outcome !== 'DATA';
}

/** The outcome label this report prints, carrying the advisory marker when `isAdvisory` holds. */
function describeOutcome(result: PanelResult): string {
  if (!isAdvisory(result)) {
    return result.outcome;
  }
  const plural = result.transformationCount === 1 ? '' : 's';
  return `${result.outcome} (advisory: panel has ${String(result.transformationCount)} transformation${plural}, which run in the browser)`;
}

async function main(): Promise<void> {
  const endMs = Date.now();
  const total = emptyCounts();
  let totalAdvisory = 0;

  for (const file of EXPLORE_FILES) {
    const results = await reportDashboard(file, endMs);
    const counts = emptyCounts();
    let advisoryCount = 0;

    for (const result of results) {
      counts[result.outcome] += 1;
      if (isAdvisory(result)) {
        advisoryCount += 1;
      }
      const suffix = result.detail !== undefined ? `: ${result.detail}` : '';
      process.stdout.write(
        `${file} panel ${String(result.panelIndex)} [${result.panelType}] ${result.panelTitle}: ${describeOutcome(result)}${suffix}\n`,
      );
    }

    process.stdout.write(
      `${file} summary: ${formatCounts(counts)}, ADVISORY ${String(advisoryCount)}\n\n`,
    );
    addCounts(total, counts);
    totalAdvisory += advisoryCount;
  }

  process.stdout.write(`total: ${formatCounts(total)}, ADVISORY ${String(totalAdvisory)}\n`);
  process.stdout.write(
    "\nThis script inspects only Grafana's backend response from /api/ds/query. A panel " +
      'transformation such as extractFields, convertFieldType, organize or joinByField runs ' +
      'later, in the browser, so this script never sees its output. Confirm any outcome ' +
      'marked advisory above by looking at the panel before treating it as a real fault.\n',
  );
}

await main();

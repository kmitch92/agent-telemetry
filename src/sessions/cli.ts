import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEventsFile } from '../events/read.js';
import { sha256Hex } from '../hash.js';
import { projectFromProjectPath } from '../replayer/parsers/index.js';
import {
  filterSessionRows,
  foldSessions,
  formatSessionsTable,
  millisFromUnixNano,
  parseSince,
  type SessionEventRecord,
} from './index.js';
import { readProjectPaths, readSessions, upsertSessions } from './store.js';

/**
 * `pnpm sessions` (SPEC.md's Session index section): reads `data/events.jsonl`,
 * folds it with `./index.ts`'s pure core, upserts into `results.duckdb` with
 * `./store.ts`, then prints the table newest first, filtered by the given
 * flags. This is the imperative shell: every computation lives in
 * `./index.ts`.
 */

const USAGE_LINE =
  'usage: pnpm sessions [--agent <name>] [--project <name>] [--since <iso|2h|30m|1d>] [--json]\n';

interface CliValues {
  agent?: string;
  project?: string;
  since?: string;
  json?: boolean;
}

async function main(): Promise<void> {
  let values: CliValues;
  try {
    ({ values } = parseArgs({
      options: {
        agent: { type: 'string' },
        project: { type: 'string' },
        since: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  let sinceMs: number | undefined;
  if (values.since !== undefined) {
    const parsed = parseSince(values.since, Date.now());
    if (parsed === undefined) {
      process.stderr.write(USAGE_LINE);
      process.exitCode = 2;
      return;
    }
    sinceMs = parsed;
  }

  const result = await readEventsFile();

  const records: SessionEventRecord[] = [];
  let dropped = 0;
  for (const record of result.records) {
    const at =
      record.timeUnixNano === undefined ? undefined : millisFromUnixNano(record.timeUnixNano);
    if (at === undefined) {
      dropped += 1;
      continue;
    }
    // The Collector only ever writes Events that already carry a
    // session_id, so no record read from a file is ever a synthetic
    // fallback: that path is reserved for an Agent that emits none.
    records.push({ event: record.event, at, synthetic_session_id: false });
  }
  if (dropped > 0) {
    process.stderr.write(`dropped: ${String(dropped)}\n`);
  }

  const projectPaths = await readProjectPaths();
  const seededProject = projectFromProjectPath(process.cwd(), sha256Hex);
  if (!projectPaths.has(seededProject)) {
    projectPaths.set(seededProject, process.cwd());
  }

  const rows = foldSessions(records, { now: Date.now(), projectPaths });
  await upsertSessions(rows);

  const stored = await readSessions();

  const filters: { agent?: string; project?: string; sinceMs?: number } = {};
  if (values.agent !== undefined) {
    filters.agent = values.agent;
  }
  if (values.project !== undefined) {
    filters.project = values.project;
  }
  if (sinceMs !== undefined) {
    filters.sinceMs = sinceMs;
  }

  const filtered = filterSessionRows(stored, filters);

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(filtered, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSessionsTable(filtered)}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

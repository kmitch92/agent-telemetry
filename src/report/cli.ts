import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEventsFile } from '../events/read.js';
import { formatReportTable, toolCallDurations } from './index.js';
import { queryReport } from './store.js';

/**
 * `pnpm report` (SPEC.md's Report section): reads `data/events.jsonl`,
 * narrows it to tool call durations with `./index.ts`'s pure core, runs the
 * Report query with `./store.ts`, then prints the result. This is the
 * imperative shell: every computation lives in `./index.ts`.
 */

const USAGE_LINE = 'usage: pnpm report [--task <id>] [--json]\n';

interface CliValues {
  task?: string;
  json?: boolean;
}

async function main(): Promise<void> {
  let values: CliValues;
  try {
    ({ values } = parseArgs({
      options: {
        task: { type: 'string' },
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

  let toolCalls: ReturnType<typeof toolCallDurations> = [];
  try {
    const result = await readEventsFile();
    toolCalls = toolCallDurations(result.events);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `report: no tool call durations, could not read the Events file: ${message}\n`,
    );
    toolCalls = [];
  }

  const queryOptions: { toolCalls: typeof toolCalls; task?: string } = { toolCalls };
  if (values.task !== undefined) {
    queryOptions.task = values.task;
  }

  const output = await queryReport(queryOptions);

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReportTable(output.rows, output.adhoc_sessions)}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import type { Dashboard } from '../schema/dashboard.js';
import { renderDashboard } from './lib.js';
import { exploreActivityDashboard } from './explore-activity.js';
import { exploreLatencyDashboard } from './explore-latency.js';
import { exploreTokensDashboard } from './explore-tokens.js';
import { liveActivityDashboard } from './live-activity.js';
import { liveBurnDashboard } from './live-burn.js';
import { liveNowDashboard } from './live-now.js';
import { liveTroubleDashboard } from './live-trouble.js';
import { mcpServersDashboard } from './mcp-servers.js';
import { runsDashboard } from './runs.js';
import { sessionsDashboard } from './sessions.js';
import { toolCallsDashboard } from './tool-calls.js';

/**
 * `pnpm dashboards:build` (SPEC.md's dashboards section): renders
 * `./sessions.ts`'s `sessionsDashboard`, `./tool-calls.ts`'s
 * `toolCallsDashboard`, `./mcp-servers.ts`'s `mcpServersDashboard` and
 * `./runs.ts`'s `runsDashboard` to JSON and writes each to its file under
 * `compose/grafana/dashboards/`, the directory Grafana's provisioning reads
 * on start. `--check` instead compares every committed file to its freshly
 * rendered string without writing, for use in CI.
 */

const OUTPUTS: readonly { path: string; dashboard: Dashboard }[] = [
  { path: 'compose/grafana/dashboards/sessions.json', dashboard: sessionsDashboard },
  { path: 'compose/grafana/dashboards/tool-calls.json', dashboard: toolCallsDashboard },
  { path: 'compose/grafana/dashboards/mcp-servers.json', dashboard: mcpServersDashboard },
  { path: 'compose/grafana/dashboards/runs.json', dashboard: runsDashboard },
  { path: 'compose/grafana/dashboards/explore-latency.json', dashboard: exploreLatencyDashboard },
  { path: 'compose/grafana/dashboards/explore-tokens.json', dashboard: exploreTokensDashboard },
  { path: 'compose/grafana/dashboards/explore-activity.json', dashboard: exploreActivityDashboard },
  { path: 'compose/grafana/dashboards/live-burn.json', dashboard: liveBurnDashboard },
  { path: 'compose/grafana/dashboards/live-activity.json', dashboard: liveActivityDashboard },
  { path: 'compose/grafana/dashboards/live-trouble.json', dashboard: liveTroubleDashboard },
  { path: 'compose/grafana/dashboards/live-now.json', dashboard: liveNowDashboard },
];

const USAGE_LINE = 'usage: pnpm dashboards:build [--check]\n';

async function main(): Promise<void> {
  let values: { check?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        check: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write(USAGE_LINE);
    process.exitCode = 2;
    return;
  }

  if (values.check === true) {
    for (const { path, dashboard } of OUTPUTS) {
      const rendered = renderDashboard(dashboard);
      const committed = await readFile(path, 'utf8');
      if (committed !== rendered) {
        process.stderr.write(`${path} is stale: run pnpm dashboards:build\n`);
        process.exitCode = 1;
      }
    }
    if (process.exitCode !== 1) {
      process.stdout.write('all dashboards are up to date\n');
    }
    return;
  }

  for (const { path, dashboard } of OUTPUTS) {
    const rendered = renderDashboard(dashboard);
    await writeFile(path, rendered, 'utf8');
    process.stdout.write(`wrote ${path} (${String(dashboard.panels.length)} panels)\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

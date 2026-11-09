/**
 * Prints a block of shell `export` lines that set the Claude Code
 * telemetry environment for a Session the operator starts by hand in a
 * terminal: `eval "$(pnpm session-env)"` run before `claude` lets that
 * Session's Events reach the Collector under a readable `session_label`
 * instead of only the opaque `session_id`.
 *
 * Pure core (`sanitizeAttributeValue`, `buildExportBlock`,
 * `buildSessionEnvOutput`) takes every real-world input as a parameter and
 * carries no `node:*` import of its own, except for the `telemetryEnv`
 * helper it reuses from `src/adapters/claude-code.ts` so the eight
 * variable names in this path and the Runner's launch path cannot drift
 * apart, and the `buildSessionLabel` helper it reuses from
 * `src/session-label.ts` so this path and `src/watch/index.ts`'s label
 * cannot drift apart either. The thin edge (`resolveBranch`,
 * `parseEndpointFlag`, `main`) is the only place that reads
 * `process.cwd()`, the real clock, `process.argv`, `process.env`, and
 * spawns `git`. The injection pattern follows `src/ulid.ts:43-49`: `main`
 * resolves every real value once and passes it down as a plain parameter.
 */
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telemetryEnv } from '../src/adapters/claude-code.js';
import { buildSessionLabel } from '../src/session-label.js';

const DEFAULT_ENDPOINT = 'http://localhost:4318';

/**
 * `OTEL_RESOURCE_ATTRIBUTES` is a comma-separated `key=value` list
 * (`src/adapters/claude-code.ts:41-43`), so a value that itself contains a
 * comma or an equals sign would either attach to the wrong key or corrupt
 * the list. Both characters are replaced with a space, not stripped
 * outright, so a label such as `a,b` degrades to the still-readable `a b`
 * instead of silently losing the separator and becoming `ab`.
 */
export function sanitizeAttributeValue(value: string): string {
  return value.replace(/[,=]/g, ' ');
}

/**
 * Renders the final block: one quoted `export KEY="VALUE"` line per
 * entry, in the order `telemetryEnv` returns them. Quoting every value
 * means a space in the label (or in any other value) survives the shell.
 */
export function buildExportBlock(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');
}

export interface SessionEnvInputs {
  cwd: string;
  now: Date;
  branch: string | undefined;
  endpoint: string;
  labelOverride: string | undefined;
}

/**
 * Pure assembly of the whole printed block from already-resolved inputs.
 * `labelOverride` wins verbatim over the computed label, letting the
 * operator name a Session with `AGENT_SESSION_LABEL`.
 */
export function buildSessionEnvOutput(p: SessionEnvInputs): string {
  const label =
    p.labelOverride !== undefined && p.labelOverride !== ''
      ? p.labelOverride
      : buildSessionLabel({ cwdBasename: basename(p.cwd), branch: p.branch, firstEventAt: p.now });

  const resource: Record<string, string> = {
    project_path: sanitizeAttributeValue(p.cwd),
    session_label: sanitizeAttributeValue(label),
  };
  if (p.branch !== undefined) {
    resource['branch'] = sanitizeAttributeValue(p.branch);
  }

  const env = telemetryEnv({ endpoint: p.endpoint, resource });
  return `${buildExportBlock(env)}\n`;
}

function runGit(args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolves the branch for the edge. A detached HEAD makes
 * `git rev-parse --abbrev-ref HEAD` print the literal string `HEAD`; this
 * falls back to the short commit in that one case, per the task's rule.
 * Any other failure (not a git repository, `git` missing, and so on)
 * returns `undefined`, which `buildSessionLabel` treats as "omit".
 */
function resolveBranch(cwd: string): string | undefined {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (branch === undefined || branch === '') {
    return undefined;
  }
  if (branch !== 'HEAD') {
    return branch;
  }
  const shortCommit = runGit(['rev-parse', '--short', 'HEAD'], cwd);
  return shortCommit === '' ? undefined : shortCommit;
}

function parseEndpointFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf('--endpoint');
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function main(): void {
  const cwd = process.cwd();
  const branch = resolveBranch(cwd);
  const endpoint = parseEndpointFlag(process.argv.slice(2)) ?? DEFAULT_ENDPOINT;
  const labelOverride = process.env['AGENT_SESSION_LABEL'];

  const output = buildSessionEnvOutput({ cwd, now: new Date(), branch, endpoint, labelOverride });
  process.stdout.write(output);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

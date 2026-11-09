/**
 * The pure Session label builder shared by `scripts/session-env.ts` (the
 * operator-run label printed into the shell environment) and
 * `src/watch/index.ts` (the watcher's own label for the same Session), so
 * the two paths cannot drift apart. No `node:*` import, no clock read, no
 * `git` spawn: every real-world input arrives as a parameter.
 *
 * Lives directly under `src/`, alongside `src/hash.ts` and `src/ulid.ts`,
 * rather than inside `src/watch/` or `scripts/`: `scripts/` already
 * depends on `src/` (`scripts/session-env.ts` imports `telemetryEnv` from
 * `src/adapters/claude-code.ts`), and no module under `src/` has ever
 * depended on `scripts/`. Reversing that so a pure core module under
 * `src/` imports from `scripts/` would invert the established layering,
 * so the shared builder lives here instead, where both sides import it
 * without either depending on the other's layer.
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Builds the `<basename of cwd> · <branch> · HH:MM` label, in the local
 * time zone of `firstEventAt`. `branch` is `undefined` when the directory
 * is not a git repository or `git` failed; the branch segment is then
 * omitted entirely, never replaced with an error or a placeholder.
 */
export function buildSessionLabel(p: {
  cwdBasename: string;
  branch: string | undefined;
  firstEventAt: Date;
}): string {
  const time = `${pad2(p.firstEventAt.getHours())}:${pad2(p.firstEventAt.getMinutes())}`;
  const segments = p.branch === undefined ? [p.cwdBasename, time] : [p.cwdBasename, p.branch, time];
  return segments.join(' · ');
}

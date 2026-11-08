import type { CheckResult } from '../schema/conform.js';

/**
 * Renders conformance-check results as a fixed-width table and derives the
 * process exit code from them. Pure: no `node:*` import, no file system, no
 * network, no process access. Mirrors the structure of
 * `formatSessionsTable` (src/sessions/index.ts).
 */

const HEADER = ['CHECK', 'RESULT', 'DETAIL'] as const;

function resultCell(row: CheckResult): string {
  if (row.pass) {
    return 'pass';
  }
  return row.severity === 'must' ? 'FAIL' : 'warn';
}

export function exitCodeFor(results: readonly CheckResult[]): number {
  return results.some((row) => row.severity === 'must' && !row.pass) ? 1 : 0;
}

export function formatCheckTable(results: readonly CheckResult[]): string {
  if (results.length === 0) {
    return 'no checks';
  }

  const grid: string[][] = [
    [...HEADER],
    ...results.map((row) => [row.id, resultCell(row), row.detail]),
  ];

  const widths = HEADER.map((_, columnIndex) =>
    Math.max(
      ...grid.map((line) => {
        const cell = line[columnIndex];
        return cell === undefined ? 0 : cell.length;
      }),
    ),
  );

  const lines = grid.map((line) =>
    line
      .map((cell, columnIndex) => {
        const width = widths[columnIndex];
        return cell.padEnd(width ?? 0);
      })
      .join('  ')
      .trimEnd(),
  );

  let mustTotal = 0;
  let mustPassed = 0;
  let warnFailed = 0;
  for (const row of results) {
    if (row.severity === 'must') {
      mustTotal += 1;
      if (row.pass) {
        mustPassed += 1;
      }
    } else if (!row.pass) {
      warnFailed += 1;
    }
  }
  const mustFailed = mustTotal - mustPassed;
  const warningWord = warnFailed === 1 ? 'warning' : 'warnings';

  const summary = `${String(mustTotal)} MUST checks: ${String(mustPassed)} passed, ${String(mustFailed)} failed. ${String(warnFailed)} ${warningWord}.`;

  return [...lines, '', summary].join('\n');
}

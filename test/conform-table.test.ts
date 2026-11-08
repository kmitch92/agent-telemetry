import { describe, expect, it } from 'vitest';
import type { CheckResult } from '../src/schema/conform.js';
import { exitCodeFor, formatCheckTable } from '../src/conform/table.js';

describe('exitCodeFor', () => {
  it('returns 0 when every MUST row passes regardless of failing warn rows, and 1 when any MUST row fails', () => {
    const passingWithWarnings: CheckResult[] = [
      { id: 'must.one', severity: 'must', pass: true, detail: 'ok' },
      { id: 'must.two', severity: 'must', pass: true, detail: 'ok' },
      { id: 'should.one', severity: 'warn', pass: false, detail: 'missing' },
      { id: 'should.two', severity: 'warn', pass: false, detail: 'missing' },
    ];
    expect(exitCodeFor(passingWithWarnings)).toBe(0);

    const oneMustFailing: CheckResult[] = [
      { id: 'must.one', severity: 'must', pass: false, detail: 'broken' },
      { id: 'must.two', severity: 'must', pass: true, detail: 'ok' },
    ];
    expect(exitCodeFor(oneMustFailing)).toBe(1);
  });

  it('returns 0 for an empty result list', () => {
    expect(exitCodeFor([])).toBe(0);
  });
});

describe('formatCheckTable', () => {
  it('returns "no checks" for an empty result list', () => {
    expect(formatCheckTable([])).toBe('no checks');
  });

  it('renders the header with padEnd widths and two-space joins', () => {
    const results: CheckResult[] = [{ id: 'abcdef', severity: 'must', pass: true, detail: 'ok' }];
    const table = formatCheckTable(results);
    const [headerLine] = table.split('\n');
    expect(headerLine).toBe('CHECK   RESULT  DETAIL');
  });

  it('renders FAIL for a failing MUST row, warn for a failing warn row, and pass otherwise', () => {
    const results: CheckResult[] = [
      { id: 'must-fa', severity: 'must', pass: false, detail: 'broken' },
      { id: 'warn-ro', severity: 'warn', pass: false, detail: 'missing' },
      { id: 'must-ok', severity: 'must', pass: true, detail: 'fine' },
    ];
    const table = formatCheckTable(results);
    const lines = table.split('\n');
    expect(lines[1]).toContain('FAIL');
    expect(lines[2]).toContain('warn');
    expect(lines[3]).toContain('pass');
  });

  it('summarises MUST and warn counts with correct singular/plural wording', () => {
    const results: CheckResult[] = [
      { id: 'must-ok', severity: 'must', pass: true, detail: 'fine' },
      { id: 'must-no', severity: 'must', pass: false, detail: 'broken' },
      { id: 'warn-no', severity: 'warn', pass: false, detail: 'missing' },
    ];
    const table = formatCheckTable(results);
    expect(table).toContain('2 MUST checks: 1 passed, 1 failed. 1 warning.');
  });

  it('uses "warnings" for a warning count of 0 and of 2', () => {
    const zeroWarnings: CheckResult[] = [
      { id: 'must-ok', severity: 'must', pass: true, detail: 'fine' },
    ];
    expect(formatCheckTable(zeroWarnings)).toContain('0 warnings.');

    const twoWarnings: CheckResult[] = [
      { id: 'must-ok', severity: 'must', pass: true, detail: 'fine' },
      { id: 'warn-a1', severity: 'warn', pass: false, detail: 'missing a' },
      { id: 'warn-a2', severity: 'warn', pass: false, detail: 'missing b' },
    ];
    expect(formatCheckTable(twoWarnings)).toContain('2 warnings.');
  });

  it('has no trailing whitespace on any line and no trailing newline overall', () => {
    const results: CheckResult[] = [
      { id: 'must-ok', severity: 'must', pass: true, detail: 'fine' },
      { id: 'warn-lo', severity: 'warn', pass: false, detail: 'missing a long detail' },
    ];
    const table = formatCheckTable(results);
    for (const line of table.split('\n')) {
      expect(line.endsWith(' ')).toBe(false);
    }
    expect(table.endsWith('\n')).toBe(false);
  });
});

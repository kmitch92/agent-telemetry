import { spawn } from 'node:child_process';

/**
 * Edge module: process spawn only. Runs the Checker command named by a Task
 * and reports its exit code and combined output.
 */

/** SPEC.md gives the Checker no timeout; an unbounded Checker would hang the Runner. */
export const CHECKER_TIMEOUT_MS = 120_000;

export interface CheckerResult {
  exit_code: number | null;
  /** Standard output and standard error, combined in arrival order. */
  output: string;
  timed_out: boolean;
}

/**
 * Spawns `sh -c <command>` in `p.cwd`, collecting standard output and
 * standard error into one string in arrival order. Never rejects: a
 * non-zero exit resolves with that exit code, and a signal death resolves
 * with `exit_code` null. After `p.timeoutMs` (default `CHECKER_TIMEOUT_MS`)
 * the process is killed with SIGKILL and `timed_out` is set to true.
 */
export function runChecker(p: {
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<CheckerResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', p.command], { cwd: p.cwd });

    let output = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, p.timeoutMs ?? CHECKER_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      output += error.message;
      resolve({ exit_code: null, output, timed_out: false });
    });

    // 'close' is used rather than 'exit' because 'exit' can fire before the
    // output streams flush, which would drop trailing Checker output.
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code: code, output, timed_out: timedOut });
    });
  });
}

import { execFile } from 'node:child_process';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

/**
 * Edge module: file system and process spawn only, no folding logic. Copies
 * a Fixture into a fresh work directory and gives the Checker a git baseline
 * to diff against (SPEC.md:412-413).
 */

const execFileAsync = promisify(execFile);

/**
 * Recursively copies `from` into `to`, creating `to` and every intermediate
 * directory. Returns the fixture-relative POSIX paths of the files copied,
 * in directory-walk order, excluding `.git` and everything under it. A
 * symbolic link entry is copied with `copyFile`, following no link; an
 * entry that is neither a file, a directory, nor a symbolic link is
 * skipped. The source directory is never modified.
 */
export async function copyFixture(from: string, to: string): Promise<string[]> {
  await mkdir(to, { recursive: true });

  const copied: string[] = [];

  async function walk(fromDir: string, toDir: string): Promise<void> {
    const entries = await readdir(fromDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === '.git') {
        continue;
      }

      const fromPath = join(fromDir, entry.name);
      const toPath = join(toDir, entry.name);

      if (entry.isDirectory()) {
        await mkdir(toPath, { recursive: true });
        await walk(fromPath, toPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        await copyFile(fromPath, toPath);
        copied.push(relative(from, fromPath).split('\\').join('/'));
      }
      // Neither a file, a directory, nor a symbolic link: skipped.
    }
  }

  await walk(from, to);

  return copied;
}

/**
 * Commits the freshly-copied work directory as a git repository, giving the
 * Checker a baseline to `git diff` against (SPEC.md:412-413). The `-c`
 * identity flags mean the commit needs no global git configuration and
 * writes nothing outside `work`.
 */
export async function initWorkGit(work: string): Promise<void> {
  await execFileAsync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: work });
  await execFileAsync('git', ['add', '-A'], { cwd: work });
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=agent-telemetry',
      '-c',
      'user.email=runner@agent-telemetry.invalid',
      'commit',
      '-q',
      '-m',
      'fixture baseline',
      '--allow-empty',
    ],
    { cwd: work },
  );
}

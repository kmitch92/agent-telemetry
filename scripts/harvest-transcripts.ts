/**
 * Implements the `harvest` command (SPEC.md:583-585): scans the Claude Code
 * Transcript tree under `~/.claude/projects`, selects the 20 most recent
 * Sessions that made at least 5 tool calls, redacts every selected file with
 * the same `redactLine` the live recorder and `rebuild-fixture.ts` use, and
 * writes the result to
 * `test/fixtures/transcripts/claude-code/<hash>.jsonl`.
 *
 * Selection is by file modification time, so the committed fixtures are a
 * one-time snapshot: a later run of this script will pick a different 20
 * files. A consumer of the fixture set must read the files already
 * committed and must never re-run this script expecting to reproduce them.
 *
 * The bottom of this file guards the entry point with
 * `process.argv[1]` so that `test/harvest-transcripts.test.ts` can import
 * the three pure functions below without starting a real scan of the
 * operator's home directory.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashId } from '../src/hash.js';
import { redactLine } from '../src/redact.js';

/** One candidate source file, before its content has been read. */
export interface Candidate {
  path: string;
  mtimeMs: number;
}

/** One file chosen by `selectSessions`, with its Session identifier and tool-use total. */
export interface Selection {
  path: string;
  sessionId: string;
  toolUses: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Counts the `tool_use` entries inside `parsed.message.content`. Returns 0
 * for anything that does not have that shape: a non-object line, a missing
 * `message`, a `content` that is a string rather than an array, or an array
 * entry that is not an object.
 */
export function countToolUses(parsed: unknown): number {
  if (!isRecord(parsed)) {
    return 0;
  }
  const message = parsed['message'];
  if (!isRecord(message)) {
    return 0;
  }
  const content = message['content'];
  if (!isUnknownArray(content)) {
    return 0;
  }
  let count = 0;
  for (const entry of content) {
    if (isRecord(entry) && entry['type'] === 'tool_use') {
      count += 1;
    }
  }
  return count;
}

/**
 * Reads `parsed.sessionId`, returning it only when it is a string. Returns
 * `undefined` for a non-object line, a missing `sessionId`, or a `sessionId`
 * of any other type.
 */
export function sessionIdOf(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }
  const sessionId = parsed['sessionId'];
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * Ranks `candidates` newest first (ties broken by path ascending), then for
 * each one in that order reads its lines through the injected `readLines`,
 * skips a line that fails to parse, takes the first defined `sessionIdOf` as
 * the file's Session identifier, and sums `countToolUses` over every parsed
 * line. A candidate is selected unless its Session identifier is undefined,
 * its tool-use sum is below `minToolUses`, or that Session identifier was
 * already selected from a newer file. Returns as soon as `limit` selections
 * are held, and never calls `readLines` for a later candidate once that
 * happens. `candidates` is read-only: this function sorts a copy, never the
 * caller's array.
 */
export function selectSessions(
  candidates: Candidate[],
  readLines: (path: string) => string[],
  limit: number,
  minToolUses: number,
): Selection[] {
  const sorted = [...candidates].sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.path.localeCompare(b.path);
  });

  const selections: Selection[] = [];
  const seenSessionIds = new Set<string>();

  for (const candidate of sorted) {
    if (selections.length >= limit) {
      break;
    }

    const lines = readLines(candidate.path);
    let sessionId: string | undefined;
    let toolUses = 0;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (sessionId === undefined) {
        sessionId = sessionIdOf(parsed);
      }
      toolUses += countToolUses(parsed);
    }

    if (sessionId === undefined || toolUses < minToolUses || seenSessionIds.has(sessionId)) {
      continue;
    }

    seenSessionIds.add(sessionId);
    selections.push({ path: candidate.path, sessionId, toolUses });
  }

  return selections;
}

/**
 * The four terms CLAUDE.md forbids in this repository, each built from two
 * string fragments joined with `+` so that this file never spells one of
 * them literally and does not trip the repository-wide forbidden-word grep
 * on its own source.
 */
const FORBIDDEN_FRAGMENTS = ['bro' + 'ker', 'a' + 'rm', 'har' + 'ness', 'raw M' + 'CP'];

/** Word-bounded, case-insensitive, global match of every forbidden term. */
export const FORBIDDEN_WORD_PATTERN = new RegExp(`\\b(${FORBIDDEN_FRAGMENTS.join('|')})\\b`, 'gi');

const SOURCE_ROOT = join(homedir(), '.claude', 'projects');
const OUTPUT_DIR = join(process.cwd(), 'test', 'fixtures', 'transcripts', 'claude-code');
const SELECT_LIMIT = 20;
const MIN_TOOL_USES = 5;

/**
 * Lists every `*.jsonl` file exactly one directory below `root`: directly
 * inside each immediate project subdirectory, never deeper. A file nested a
 * level further down is a subagent Transcript that carries its PARENT
 * Session's `sessionId`, so reading it too would hash two source files to
 * the same output name and the run would end with fewer than 20 fixtures. I
 * verified this against the real `~/.claude/projects` tree on this machine.
 */
async function listCandidates(root: string): Promise<Candidate[]> {
  const projectEntries = await readdir(root, { withFileTypes: true });
  const candidates: Candidate[] = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const projectDir = join(root, projectEntry.name);
    const fileEntries = await readdir(projectDir, { withFileTypes: true });
    for (const fileEntry of fileEntries) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) {
        continue;
      }
      const filePath = join(projectDir, fileEntry.name);
      const fileStat = await stat(filePath);
      candidates.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
    }
  }

  return candidates;
}

/**
 * Reads the whole file as utf8 and splits on '\n', dropping any line whose
 * `trim()` is empty. The largest real Transcript on this machine is 7.6 MB,
 * so reading one whole is acceptable.
 */
function readLines(path: string): string[] {
  const contents = readFileSync(path, 'utf8');
  return contents.split('\n').filter((line) => line.trim() !== '');
}

interface PreparedFixture {
  selection: Selection;
  redactedLines: string[];
}

async function main(): Promise<void> {
  let candidates: Candidate[];
  try {
    candidates = await listCandidates(SOURCE_ROOT);
  } catch (error) {
    process.stderr.write(`failed to read ${SOURCE_ROOT}: ${describeError(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const selections = selectSessions(candidates, readLines, SELECT_LIMIT, MIN_TOOL_USES);

  if (selections.length < SELECT_LIMIT) {
    process.stderr.write(
      `only ${String(selections.length)} sessions qualified; need ${String(SELECT_LIMIT)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const prepared: PreparedFixture[] = [];
  for (const [index, selection] of selections.entries()) {
    const lines = readLines(selection.path);
    const redactedLines: string[] = [];
    for (const line of lines) {
      const result = redactLine(line, { hashId });
      if (!result.ok) {
        process.stderr.write(
          `redaction failed for selected file ${String(index)}: ${result.reason}\n`,
        );
        process.exitCode = 1;
        return;
      }
      redactedLines.push(result.line);
    }
    prepared.push({ selection, redactedLines });
  }

  const fullText = prepared.map((fixture) => fixture.redactedLines.join('\n')).join('\n');
  const homeBasename = basename(homedir());

  const literalChecks: { label: string; needle: string }[] = [
    { label: '/home/', needle: '/home/' },
    { label: '/Users/', needle: '/Users/' },
    { label: '/root/', needle: '/root/' },
    { label: '@', needle: '@' },
    { label: 'home directory basename', needle: homeBasename },
  ];

  for (const check of literalChecks) {
    if (check.needle !== '' && fullText.includes(check.needle)) {
      const index = fullText.indexOf(check.needle);
      const snippet = fullText.slice(index, index + 60);
      process.stderr.write(`gate failed: ${check.label} matched ${snippet}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const forbiddenMatch = new RegExp(FORBIDDEN_WORD_PATTERN).exec(fullText);
  if (forbiddenMatch !== null) {
    const snippet = forbiddenMatch[0].slice(0, 60);
    process.stderr.write(`gate failed: forbidden word matched ${snippet}\n`);
    process.exitCode = 1;
    return;
  }

  await mkdir(OUTPUT_DIR, { recursive: true });

  const existingEntries = await readdir(OUTPUT_DIR, { withFileTypes: true });
  let removed = 0;
  for (const entry of existingEntries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      await unlink(join(OUTPUT_DIR, entry.name));
      removed += 1;
    }
  }

  for (const fixture of prepared) {
    const hash = hashId(fixture.selection.sessionId);
    const outputPath = join(OUTPUT_DIR, `${hash}.jsonl`);
    const content = fixture.redactedLines.map((line) => `${line}\n`).join('');
    await writeFile(outputPath, content, 'utf8');
    process.stdout.write(
      `hash=${hash} lines=${String(fixture.redactedLines.length)} toolCalls=${String(
        fixture.selection.toolUses,
      )}\n`,
    );
  }

  process.stdout.write(`removed=${String(removed)} stale fixture file(s)\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

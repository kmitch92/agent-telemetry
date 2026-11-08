import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Event } from '../schema/index.js';
import { classifyLine } from './line.js';
import type { EventRecord } from './line.js';

/**
 * Streams an Events file. This is the only module under `src/events/` that
 * touches `node:fs`: `line.ts` stays pure so it can be unit-tested without a
 * file system.
 */

/** Relative path, never an absolute home-directory path. */
export const DEFAULT_EVENTS_PATH = 'data/events.jsonl';

/** The folded outcome of reading one Events file. */
export interface ReadResult {
  events: Event[];
  records: EventRecord[];
  unknownKindsByAgent: Record<string, number>;
  malformed: number;
  lines: number;
}

/** Minimal shape of a Node error that carries a `code`, used without a cast. */
interface ErrnoLike {
  code?: string;
}

function hasErrorCode(error: unknown): error is ErrnoLike {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isMissingFileError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 'ENOENT';
}

/**
 * Streams every line of `path` to `onLine`, line by line, so a rotated
 * multi-megabyte Events file never loads whole into memory.
 */
function streamLines(path: string, onLine: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lineReader = createInterface({ input: stream, crlfDelay: Infinity });

    lineReader.on('error', (error: Error) => {
      reject(error);
    });

    lineReader.on('line', (line: string) => {
      onLine(line);
    });

    lineReader.on('close', () => {
      resolve();
    });
  });
}

/**
 * Reads and classifies every line of an Events file. Resolves to an empty
 * result, rather than rejecting, when the file does not exist yet, because
 * the Runner polls before the Collector has written anything.
 */
export async function readEventsFile(path: string = DEFAULT_EVENTS_PATH): Promise<ReadResult> {
  const result: ReadResult = {
    events: [],
    records: [],
    unknownKindsByAgent: {},
    malformed: 0,
    lines: 0,
  };

  try {
    await streamLines(path, (line) => {
      if (line.trim() === '') {
        return;
      }

      result.lines += 1;

      for (const outcome of classifyLine(line)) {
        if (outcome.outcome === 'event') {
          result.events.push(outcome.record.event);
          result.records.push(outcome.record);
        } else if (outcome.outcome === 'unknown_kind') {
          result.unknownKindsByAgent[outcome.agent] =
            (result.unknownKindsByAgent[outcome.agent] ?? 0) + 1;
        } else {
          result.malformed += 1;
        }
      }
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return result;
    }
    throw error;
  }

  return result;
}

/**
 * Counts the non-empty lines of an Events file without parsing them, so the
 * Runner can poll for growth cheaply. Returns 0 for a missing file.
 */
export async function countEventLines(path: string = DEFAULT_EVENTS_PATH): Promise<number> {
  let count = 0;

  try {
    await streamLines(path, (line) => {
      if (line.trim() !== '') {
        count += 1;
      }
    });
  } catch (error) {
    if (isMissingFileError(error)) {
      return 0;
    }
    throw error;
  }

  return count;
}

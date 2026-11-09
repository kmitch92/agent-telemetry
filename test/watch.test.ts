import { describe, expect, it } from 'vitest';
import {
  applyTailChunk,
  buildSessionLabel,
  createEventClock,
  eventTimeNano,
  INITIAL_FILE_TRACK_STATE,
  linesOfWholeFile,
  parseEventsSince,
  planFilePoll,
  selectNewEvents,
} from '../src/watch/index.js';
import type { FileTrackState } from '../src/watch/index.js';
import { decideAndRead, initialTrackFor } from '../src/watch/cli.js';
import type { TranscriptReader } from '../src/watch/cli.js';
import { createOtlpSender } from '../src/events/otlp.js';
import { OtlpLogsPayloadSchema } from '../src/events/otlp-payload.js';
import type { Event } from '../src/schema/events.js';

/**
 * Tests for `src/watch/index.ts`'s pure core and `src/watch/cli.ts`'s
 * testable, injected-dependency orchestration functions. No real file
 * system and no real network for the index.ts tests; `decideAndRead` and
 * `initialTrackFor` are exercised through a fake `TranscriptReader`, never
 * real `node:fs`. Every input below is a fixture line built by hand in
 * this file, never copied from a real Transcript.
 *
 * `planTailRead` and `tailAndParse` (the per-batch byte-tailing design)
 * are REMOVED along with their tests below: that design is the defect
 * this change fixes — a `tool_use`/`tool_result` pair split across two
 * polls could never meet inside one `parse` call — so keeping it around,
 * even unused, would invite a future regression back onto it. The
 * replacement is `parseEventsSince`, which always re-parses a file's
 * complete lines. `applyTailChunk` itself is kept: it still correctly
 * splits a chunk into complete lines plus a held partial one, which
 * `linesOfWholeFile` below still relies on, and its own existing test
 * below still describes real, unchanged behaviour.
 */

const PROJECT = 'agent-telemetry-deadbeef';

function promptLine(p: { sessionId: string; timestamp: string; content: string }): string {
  return JSON.stringify({
    type: 'user',
    sessionId: p.sessionId,
    timestamp: p.timestamp,
    message: { content: p.content },
  });
}

function assistantToolUseLine(p: {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  toolName: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: p.sessionId,
    timestamp: p.timestamp,
    message: {
      model: 'claude-synthetic',
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'tool_use', id: p.toolUseId, name: p.toolName }],
    },
  });
}

function toolResultLine(p: { sessionId: string; timestamp: string; toolUseId: string }): string {
  return JSON.stringify({
    type: 'user',
    sessionId: p.sessionId,
    timestamp: p.timestamp,
    message: {
      content: [{ type: 'tool_result', tool_use_id: p.toolUseId, content: 'ok' }],
    },
  });
}

describe('planFilePoll', () => {
  it('skips the read when the file size is unchanged', () => {
    const previous: FileTrackState = { size: 200, sentCount: 7 };
    expect(planFilePoll(previous, 200)).toEqual({ shouldRead: false, baselineSentCount: 7 });
  });

  it('plans a read with the previous sentCount as baseline when the file grew', () => {
    const previous: FileTrackState = { size: 200, sentCount: 7 };
    expect(planFilePoll(previous, 350)).toEqual({ shouldRead: true, baselineSentCount: 7 });
  });

  it('plans a read with a zero baseline when the file shrank (truncated or rotated)', () => {
    const previous: FileTrackState = { size: 500, sentCount: 9 };
    expect(planFilePoll(previous, 80)).toEqual({ shouldRead: true, baselineSentCount: 0 });
  });
});

describe('linesOfWholeFile', () => {
  it('drops a trailing line with no terminating newline', () => {
    const lines = linesOfWholeFile('one\ntwo\nthree-incomplete');
    expect(lines).toEqual(['one', 'two']);
  });

  it('keeps every line when the content ends with a newline', () => {
    const lines = linesOfWholeFile('one\ntwo\n');
    expect(lines).toEqual(['one', 'two']);
  });
});

describe('selectNewEvents', () => {
  it('returns only the events beyond the baseline count', () => {
    const line1 = promptLine({
      sessionId: 's',
      timestamp: '2024-01-01T00:00:00.000Z',
      content: 'a',
    });
    const parse = parseEventsSince({
      lines: [line1],
      fileSize: 10,
      project: PROJECT,
      baselineSentCount: 0,
    });
    expect(selectNewEvents(parse.parse.events, 0)).toEqual(parse.parse.events);
    expect(selectNewEvents(parse.parse.events, 1)).toEqual([]);
  });
});

describe('parseEventsSince: a tool_use/tool_result pair split across two polls', () => {
  it('produces the tool_call Event once the result lands, instead of losing it', () => {
    const toolUseLine = assistantToolUseLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      toolUseId: 'tool-1',
      toolName: 'Read',
    });

    // Poll 1: only the tool_use half is on disk yet.
    const first = parseEventsSince({
      lines: [toolUseLine],
      fileSize: 100,
      project: PROJECT,
      baselineSentCount: 0,
    });
    expect(first.parse.unpairedToolUses).toHaveLength(1);
    expect(first.newEvents).toHaveLength(1);
    expect(first.newEvents[0]?.event.kind).toBe('model_call');
    expect(first.track).toEqual({ size: 100, sentCount: 1 });

    // Poll 2: the file grew to include the tool_result too. The OLD
    // per-batch design would hand the parser only the new line, so the
    // pair could never meet; this re-parses the WHOLE file instead.
    const resultLine = toolResultLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:10.000Z',
      toolUseId: 'tool-1',
    });
    const second = parseEventsSince({
      lines: [toolUseLine, resultLine],
      fileSize: 200,
      project: PROJECT,
      baselineSentCount: first.track.sentCount,
    });

    expect(second.parse.unpairedToolUses).toHaveLength(0);
    expect(second.parse.events).toHaveLength(2);
    expect(second.newEvents).toHaveLength(1);
    expect(second.newEvents[0]?.event.kind).toBe('tool_call');
    expect(second.track).toEqual({ size: 200, sentCount: 2 });
  });
});

describe('parseEventsSince: a file that grew', () => {
  it('produces only the Events appended since the previous poll', () => {
    const line1 = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      content: 'first',
    });
    const line2 = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:10.000Z',
      content: 'second',
    });

    const first = parseEventsSince({
      lines: [line1],
      fileSize: 50,
      project: PROJECT,
      baselineSentCount: 0,
    });
    expect(first.newEvents).toHaveLength(1);

    const second = parseEventsSince({
      lines: [line1, line2],
      fileSize: 100,
      project: PROJECT,
      baselineSentCount: first.track.sentCount,
    });

    expect(second.newEvents).toHaveLength(1);
    expect(second.newEvents[0]?.event.kind).toBe('prompt');
    if (second.newEvents[0]?.event.kind === 'prompt') {
      expect(second.newEvents[0].event.prompt_length).toBe('second'.length);
    }
  });
});

describe('parseEventsSince: the same Event is never sent twice across consecutive polls', () => {
  it('the union of every poll’s newEvents matches the final full parse exactly once each', () => {
    const line1 = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      content: 'one',
    });
    const line2 = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:10.000Z',
      content: 'two',
    });
    const line3 = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:20.000Z',
      content: 'three',
    });

    const poll1 = parseEventsSince({
      lines: [line1],
      fileSize: 10,
      project: PROJECT,
      baselineSentCount: 0,
    });
    const poll2 = parseEventsSince({
      lines: [line1, line2],
      fileSize: 20,
      project: PROJECT,
      baselineSentCount: poll1.track.sentCount,
    });
    const poll3 = parseEventsSince({
      lines: [line1, line2, line3],
      fileSize: 30,
      project: PROJECT,
      baselineSentCount: poll2.track.sentCount,
    });

    const sentLengths = [poll1.newEvents.length, poll2.newEvents.length, poll3.newEvents.length];
    expect(sentLengths).toEqual([1, 1, 1]);

    const everSent = [...poll1.newEvents, ...poll2.newEvents, ...poll3.newEvents];
    expect(everSent).toEqual(poll3.parse.events);
  });
});

describe('parseEventsSince: a file that shrank (truncated or rotated)', () => {
  it('resets and resends from the beginning', () => {
    const grownTrack: FileTrackState = { size: 500, sentCount: 2 };
    const shrunkPlan = planFilePoll(grownTrack, 80);
    expect(shrunkPlan).toEqual({ shouldRead: true, baselineSentCount: 0 });

    const line = promptLine({
      sessionId: 'sess-1',
      timestamp: '2024-01-01T00:00:00.000Z',
      content: 'after truncation',
    });

    const result = parseEventsSince({
      lines: [line],
      fileSize: 80,
      project: PROJECT,
      baselineSentCount: shrunkPlan.baselineSentCount,
    });

    expect(result.newEvents).toHaveLength(1);
    expect(result.track).toEqual({ size: 80, sentCount: 1 });
  });
});

describe('decideAndRead', () => {
  it('causes no re-read at all when the file size is unchanged', async () => {
    let readWholeCalls = 0;
    const reader: TranscriptReader = {
      statSize: () => Promise.resolve(500),
      readWhole: () => {
        readWholeCalls += 1;
        return Promise.resolve('content');
      },
    };

    const first = await decideAndRead('fake.jsonl', INITIAL_FILE_TRACK_STATE, reader);
    expect(first.shouldRead).toBe(true);
    expect(readWholeCalls).toBe(1);

    const second = await decideAndRead('fake.jsonl', { size: 500, sentCount: 3 }, reader);
    expect(second.shouldRead).toBe(false);
    expect(readWholeCalls).toBe(1);
  });
});

describe('initialTrackFor', () => {
  const existingPrompt = promptLine({
    sessionId: 'sess-1',
    timestamp: '2024-01-01T00:00:00.000Z',
    content: 'already here before the watcher started',
  });
  const content = `${existingPrompt}\n`;
  const reader: TranscriptReader = {
    statSize: () => Promise.resolve(content.length),
    readWhole: () => Promise.resolve(content),
  };

  it('without --backfill, sends nothing for a file already on disk', async () => {
    const track = await initialTrackFor('fake.jsonl', false, PROJECT, reader);
    expect(track).toEqual({ size: content.length, sentCount: 1 });

    const decision = await decideAndRead('fake.jsonl', track, reader);
    expect(decision.shouldRead).toBe(false);
  });

  it('with --backfill, sends everything already on disk', async () => {
    const track = await initialTrackFor('fake.jsonl', true, PROJECT, reader);
    expect(track).toEqual(INITIAL_FILE_TRACK_STATE);

    const decision = await decideAndRead('fake.jsonl', track, reader);
    expect(decision.shouldRead).toBe(true);
    const lines = linesOfWholeFile(decision.content ?? '');
    const result = parseEventsSince({
      lines,
      fileSize: decision.fileSize ?? 0,
      project: PROJECT,
      baselineSentCount: decision.baselineSentCount,
    });
    expect(result.newEvents).toHaveLength(1);
  });
});

describe('applyTailChunk', () => {
  it('leaves offset and partial unchanged when the chunk is empty', () => {
    const result = applyTailChunk({ offset: 10, partial: 'abc', chunk: '', chunkBytes: 0 });
    expect(result).toEqual({ lines: [], state: { offset: 10, partial: 'abc' } });
  });
});

describe('createEventClock', () => {
  it('returns exactly the nanosecond value last given to setNext, never a wall-clock reading', () => {
    const clock = createEventClock();
    clock.setNext(12345n);
    expect(clock.now()).toBe(12345n);
    clock.setNext(999999999999999n);
    expect(clock.now()).toBe(999999999999999n);
  });
});

describe('eventTimeNano', () => {
  it('parses a valid nanosecond epoch string into the same bigint', () => {
    expect(eventTimeNano('1700000000000000000')).toBe(1700000000000000000n);
  });

  it('falls back to the Unix epoch (0n) for an unparseable string, rather than silently using "now"', () => {
    expect(eventTimeNano('abc')).toBe(0n);
    expect(eventTimeNano('12.5')).toBe(0n);
  });
});

describe('watch Events carry the Transcript’s own time, not the send time', () => {
  it('stamps two Events emitted in the same batch with their own distinct times', async () => {
    const clock = createEventClock();
    let capturedBody = '';
    const fetchImpl: typeof fetch = (_input, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : '';
      return Promise.resolve(new Response(null, { status: 200 }));
    };

    const sender = createOtlpSender({
      serviceName: 'claude-code',
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://example.invalid' },
      installSignalHandlers: false,
      now: clock.now,
      fetchImpl,
    });

    const eventA: Event = {
      kind: 'prompt',
      agent: 'claude-code',
      session_id: 'sess-1',
      project: PROJECT,
      prompt_length: 1,
    };
    const eventB: Event = {
      kind: 'prompt',
      agent: 'claude-code',
      session_id: 'sess-1',
      project: PROJECT,
      prompt_length: 2,
    };

    clock.setNext(eventTimeNano('1700000000000000000'));
    sender.emit(eventA, 'watch.prompt');
    clock.setNext(eventTimeNano('1700000050000000000'));
    sender.emit(eventB, 'watch.prompt');

    await sender.flush();

    const payload = OtlpLogsPayloadSchema.parse(JSON.parse(capturedBody));
    const logRecords = payload.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [];

    expect(logRecords).toHaveLength(2);
    expect(logRecords[0]?.timeUnixNano).toBe('1700000000000000000');
    expect(logRecords[0]?.observedTimeUnixNano).toBe('1700000000000000000');
    expect(logRecords[1]?.timeUnixNano).toBe('1700000050000000000');
    expect(logRecords[1]?.observedTimeUnixNano).toBe('1700000050000000000');
  });
});

describe('buildSessionLabel', () => {
  it('produces "<basename> · <branch> · HH:MM" when a branch is given', () => {
    const label = buildSessionLabel({
      cwdBasename: 'myproj',
      branch: 'main',
      firstEventAt: new Date(2024, 0, 1, 9, 5),
    });
    expect(label).toBe('myproj · main · 09:05');
  });

  it('omits the branch segment when no branch is given', () => {
    const label = buildSessionLabel({
      cwdBasename: 'myproj',
      branch: undefined,
      firstEventAt: new Date(2024, 0, 1, 9, 5),
    });
    expect(label).toBe('myproj · 09:05');
  });
});

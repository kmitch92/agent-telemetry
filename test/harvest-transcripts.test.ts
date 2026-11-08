import { describe, expect, it } from 'vitest';
import { countToolUses, selectSessions, sessionIdOf } from '../scripts/harvest-transcripts.js';
import type { Candidate } from '../scripts/harvest-transcripts.js';

describe('countToolUses', () => {
  it('returns 0 for a string', () => {
    expect(countToolUses('not-an-object')).toBe(0);
  });

  it('returns 0 for a number', () => {
    expect(countToolUses(42)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(countToolUses(null)).toBe(0);
  });

  it('returns 0 for an empty object', () => {
    expect(countToolUses({})).toBe(0);
  });

  it('returns 0 when message.content is a string rather than an array', () => {
    expect(countToolUses({ message: { content: 'plain text' } })).toBe(0);
  });

  it('returns 2 for a line whose message.content holds one text entry and two tool_use entries', () => {
    const line = {
      message: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'Read' },
          { type: 'tool_use', name: 'Write' },
        ],
      },
    };
    expect(countToolUses(line)).toBe(2);
  });

  it('returns 0 when an entry of message.content is not an object', () => {
    const line = { message: { content: ['just-a-string', 7, null] } };
    expect(countToolUses(line)).toBe(0);
  });

  it('returns 0 when message exists but has no content', () => {
    expect(countToolUses({ message: {} })).toBe(0);
  });
});

describe('sessionIdOf', () => {
  it("returns 'abc' for { sessionId: 'abc' }", () => {
    expect(sessionIdOf({ sessionId: 'abc' })).toBe('abc');
  });

  it('returns undefined when sessionId is absent', () => {
    expect(sessionIdOf({})).toBeUndefined();
  });

  it('returns undefined when sessionId is a number', () => {
    expect(sessionIdOf({ sessionId: 123 })).toBeUndefined();
  });

  it('returns undefined for a non-object value', () => {
    expect(sessionIdOf('not-an-object')).toBeUndefined();
  });
});

describe('selectSessions', () => {
  function toolUseLine(sessionId: string, toolUses: number): string {
    const content = Array.from({ length: toolUses }, () => ({ type: 'tool_use', name: 'Read' }));
    return JSON.stringify({ sessionId, message: { content } });
  }

  it('ranks newest first', () => {
    const candidates: Candidate[] = [
      { path: '/a', mtimeMs: 100 },
      { path: '/b', mtimeMs: 300 },
      { path: '/c', mtimeMs: 200 },
    ];
    const lines: Record<string, string[]> = {
      '/a': [toolUseLine('session-a', 5)],
      '/b': [toolUseLine('session-b', 5)],
      '/c': [toolUseLine('session-c', 5)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result.map((selection) => selection.path)).toEqual(['/b', '/c', '/a']);
  });

  it('breaks a tie on equal mtimeMs by path ascending', () => {
    const candidates: Candidate[] = [
      { path: '/zebra', mtimeMs: 100 },
      { path: '/apple', mtimeMs: 100 },
    ];
    const lines: Record<string, string[]> = {
      '/zebra': [toolUseLine('session-zebra', 5)],
      '/apple': [toolUseLine('session-apple', 5)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result.map((selection) => selection.path)).toEqual(['/apple', '/zebra']);
  });

  it('skips a file whose tool-use count is below minToolUses', () => {
    const candidates: Candidate[] = [{ path: '/low', mtimeMs: 100 }];
    const lines: Record<string, string[]> = {
      '/low': [toolUseLine('session-low', 2)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 5);
    expect(result).toEqual([]);
  });

  it('skips a file with no sessionId', () => {
    const candidates: Candidate[] = [{ path: '/nosession', mtimeMs: 100 }];
    const lines: Record<string, string[]> = {
      '/nosession': [
        JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Read' }] } }),
      ],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result).toEqual([]);
  });

  it('deduplicates a repeated sessionId, keeping the newer file only', () => {
    const candidates: Candidate[] = [
      { path: '/older', mtimeMs: 100 },
      { path: '/newer', mtimeMs: 200 },
    ];
    const lines: Record<string, string[]> = {
      '/older': [toolUseLine('shared-session', 5)],
      '/newer': [toolUseLine('shared-session', 5)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result).toEqual([{ path: '/newer', sessionId: 'shared-session', toolUses: 5 }]);
  });

  it('stops at limit, returning exactly limit entries when more qualify', () => {
    const candidates: Candidate[] = [
      { path: '/one', mtimeMs: 300 },
      { path: '/two', mtimeMs: 200 },
      { path: '/three', mtimeMs: 100 },
    ];
    const lines: Record<string, string[]> = {
      '/one': [toolUseLine('session-one', 5)],
      '/two': [toolUseLine('session-two', 5)],
      '/three': [toolUseLine('session-three', 5)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 2, 1);
    expect(result).toHaveLength(2);
    expect(result.map((selection) => selection.path)).toEqual(['/one', '/two']);
  });

  it('returns fewer than limit when too few qualify, without throwing', () => {
    const candidates: Candidate[] = [{ path: '/only', mtimeMs: 100 }];
    const lines: Record<string, string[]> = {
      '/only': [toolUseLine('session-only', 5)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result).toHaveLength(1);
  });

  it('tolerates an unparseable line inside an otherwise good file', () => {
    const candidates: Candidate[] = [{ path: '/mixed', mtimeMs: 100 }];
    const lines: Record<string, string[]> = {
      '/mixed': ['not-json-at-all{{{', toolUseLine('session-mixed', 3)],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 3);
    expect(result).toEqual([{ path: '/mixed', sessionId: 'session-mixed', toolUses: 3 }]);
  });

  it('reports the summed toolUses on each returned Selection', () => {
    const candidates: Candidate[] = [{ path: '/summed', mtimeMs: 100 }];
    const lines: Record<string, string[]> = {
      '/summed': [
        JSON.stringify({ sessionId: 'session-summed' }),
        toolUseLine('session-summed', 2),
        toolUseLine('session-summed', 3),
      ],
    };
    const readLines = (path: string): string[] => lines[path] ?? [];
    const result = selectSessions(candidates, readLines, 10, 1);
    expect(result).toEqual([{ path: '/summed', sessionId: 'session-summed', toolUses: 5 }]);
  });

  it('never calls readLines for a path after the limit is reached', () => {
    const candidates: Candidate[] = [
      { path: '/first', mtimeMs: 300 },
      { path: '/second', mtimeMs: 200 },
      { path: '/third', mtimeMs: 100 },
    ];
    const lines: Record<string, string[]> = {
      '/first': [toolUseLine('session-first', 5)],
      '/second': [toolUseLine('session-second', 5)],
      '/third': [toolUseLine('session-third', 5)],
    };
    const requestedPaths: string[] = [];
    const readLines = (path: string): string[] => {
      requestedPaths.push(path);
      return lines[path] ?? [];
    };
    const result = selectSessions(candidates, readLines, 1, 1);
    expect(result).toHaveLength(1);
    expect(requestedPaths).toEqual(['/first']);
  });
});

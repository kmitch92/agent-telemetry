import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KEEP_NAMES,
  collectNamedStrings,
  collectObjectKeys,
  isContentKey,
  policyFor,
  redactJson,
  redactLine,
} from '../src/redact.js';
import type { RedactOptions } from '../src/redact.js';
import { hashId as realHashId } from '../src/hash.js';
import { FORBIDDEN_WORD_PATTERN, selectSessions } from '../scripts/harvest-transcripts.js';
import type { Candidate } from '../scripts/harvest-transcripts.js';

const TRANSCRIPT_FIXTURES_DIR = 'test/fixtures/transcripts/claude-code';

/**
 * The 20 harvested Transcript Fixtures are excluded from version control
 * (23 MB) and regenerated locally with `pnpm harvest`, so this read must
 * never throw on a clean clone that lacks them.
 */
function listJsonlFixtureNames(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
}

const TRANSCRIPT_FIXTURES_USABLE = listJsonlFixtureNames(TRANSCRIPT_FIXTURES_DIR).length > 0;

/**
 * Stub hashId: pure and deterministic, so the test depends on no
 * node:crypto. Same input always yields the same, fixed-shape output.
 */
const hashId = (value: string): string => `hashed-${String(value.length)}-${value.slice(0, 6)}`;

const options: RedactOptions = { hashId };

/** Narrows `unknown` to a plain object, the same shape `redactJson` can return. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extracts the first `{"key":"<name>","value":{"stringValue":"..."}}` payload string. */
function extractAttributeStringValue(json: string, name: string): string | undefined {
  const pattern = new RegExp(`"key":"${name}","value":\\{"stringValue":"([^"]*)"\\}`);
  return json.match(pattern)?.[1];
}

describe('redactJson over an OTLP log envelope', () => {
  const PROMPT_MARKER = 'prompt-marker-text-one';
  const PATH_MARKER = '/home/user/secret-path-marker-two';
  const TOOL_INPUT_MARKER = 'tool-input-blob-marker-three';
  const TOOL_OUTPUT_MARKER = 'tool-output-blob-marker-four';
  const SESSION_ID = 'a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6';

  const envelope = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'claude-code' } },
            { key: 'session_id', value: { stringValue: SESSION_ID } },
          ],
        },
        scopeLogs: [
          {
            scope: { name: 'agent-telemetry', version: '0.1.0' },
            logRecords: [
              {
                timeUnixNano: '1794103594282000000',
                observedTimeUnixNano: '1794103594282000000',
                severityNumber: 9,
                severityText: 'INFO',
                body: {},
                attributes: [
                  { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
                  { key: 'kind', value: { stringValue: 'prompt' } },
                  { key: 'prompt_length', value: { intValue: '7' } },
                  { key: 'prompt', value: { stringValue: PROMPT_MARKER } },
                  { key: 'file_path', value: { stringValue: PATH_MARKER } },
                  { key: 'tool_input', value: { stringValue: TOOL_INPUT_MARKER } },
                  { key: 'tool_output', value: { stringValue: TOOL_OUTPUT_MARKER } },
                  { key: 'name', value: { stringValue: 'mcp__probe__ping' } },
                ],
                eventName: 'claude_code.user_prompt',
              },
            ],
          },
        ],
      },
    ],
  };

  it('strips every marker string from the redacted output', () => {
    const output = JSON.stringify(redactJson(envelope, options));

    expect(output).not.toContain(PROMPT_MARKER);
    expect(output).not.toContain(PATH_MARKER);
    expect(output).not.toContain(TOOL_INPUT_MARKER);
    expect(output).not.toContain(TOOL_OUTPUT_MARKER);
  });

  it('keeps the structural OTLP fields byte for byte', () => {
    const output = JSON.stringify(redactJson(envelope, options));

    expect(output).toContain('"eventName":"claude_code.user_prompt"');
    expect(output).toContain('"stringValue":"claude_code.user_prompt"');
    expect(output).toContain('"timeUnixNano":"1794103594282000000"');
    expect(output).toContain('"observedTimeUnixNano":"1794103594282000000"');
    expect(output).toContain('"severityText":"INFO"');
    expect(output).toContain('"severityNumber":9');
    expect(output).toContain('"intValue":"7"');
    expect(output).toContain('"stringValue":"claude-code"');
    expect(output).toContain('"name":"agent-telemetry"');
    expect(output).toContain('"version":"0.1.0"');
    expect(output).toContain('"stringValue":"mcp__probe__ping"');
  });

  it('hashes the session_id to a different, stable value across two separate calls', () => {
    const beforeCallJson = JSON.stringify(envelope);

    const output1 = JSON.stringify(redactJson(envelope, options));
    const output2 = JSON.stringify(redactJson(envelope, options));

    const hashedSessionId1 = extractAttributeStringValue(output1, 'session_id');
    const hashedSessionId2 = extractAttributeStringValue(output2, 'session_id');

    expect(typeof hashedSessionId1).toBe('string');
    expect(hashedSessionId1).not.toBe(SESSION_ID);
    expect(hashedSessionId1).toBe(hashedSessionId2);

    expect(JSON.stringify(envelope)).toBe(beforeCallJson);
  });

  it('replaces each marker with a same-length placeholder', () => {
    const output = JSON.stringify(redactJson(envelope, options));

    const redactedPrompt = extractAttributeStringValue(output, 'prompt');
    const redactedPath = extractAttributeStringValue(output, 'file_path');
    const redactedToolInput = extractAttributeStringValue(output, 'tool_input');
    const redactedToolOutput = extractAttributeStringValue(output, 'tool_output');

    expect(typeof redactedPrompt).toBe('string');
    expect((redactedPrompt ?? '').length).toBe(PROMPT_MARKER.length);

    expect(typeof redactedPath).toBe('string');
    expect((redactedPath ?? '').length).toBe(PATH_MARKER.length);

    expect(typeof redactedToolInput).toBe('string');
    expect((redactedToolInput ?? '').length).toBe(TOOL_INPUT_MARKER.length);

    expect(typeof redactedToolOutput).toBe('string');
    expect((redactedToolOutput ?? '').length).toBe(TOOL_OUTPUT_MARKER.length);
  });

  it('does not mutate the input envelope', () => {
    const beforeJson = JSON.stringify(envelope);
    redactJson(envelope, options);
    const afterJson = JSON.stringify(envelope);

    expect(afterJson).toBe(beforeJson);
  });
});

describe('redactJson over a Claude Code transcript record', () => {
  const TEXT_MARKER = 'assistant-text-marker-one';
  const COMMAND_MARKER = 'bash-command-marker-two';
  const RESULT_MARKER = 'tool-result-marker-three';

  const transcriptRecord = {
    type: 'assistant',
    role: 'assistant',
    timestamp: '2026-11-08T12:00:00.000Z',
    uuid: 'uuid-top-0001',
    parentUuid: 'uuid-parent-0000',
    message: {
      content: [
        { type: 'text', text: TEXT_MARKER },
        {
          type: 'tool_use',
          id: 'toolu_abc123',
          name: 'Bash',
          input: { command: COMMAND_MARKER },
        },
        { type: 'tool_result', tool_use_id: 'toolu_abc123', content: RESULT_MARKER },
      ],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_read_input_tokens: 6,
      },
    },
  };

  it('strips every marker string from the redacted output', () => {
    const output = JSON.stringify(redactJson(transcriptRecord, options));

    expect(output).not.toContain(TEXT_MARKER);
    expect(output).not.toContain(COMMAND_MARKER);
    expect(output).not.toContain(RESULT_MARKER);
  });

  it('keeps the transcript envelope fields and usage numbers byte for byte', () => {
    const output = JSON.stringify(redactJson(transcriptRecord, options));

    expect(output).toContain('"type":"assistant"');
    expect(output).toContain('"role":"assistant"');
    expect(output).toContain('"timestamp":"2026-11-08T12:00:00.000Z"');
    expect(output).toContain('"uuid":"uuid-top-0001"');
    expect(output).toContain('"parentUuid":"uuid-parent-0000"');
    expect(output).toContain('"stop_reason":"end_turn"');
    expect(output).toContain('"tool_use_id":"toolu_abc123"');
    expect(output).toContain('"id":"toolu_abc123"');
    expect(output).toContain('"name":"Bash"');
    expect(output).toContain('"input_tokens":123');
    expect(output).toContain('"output_tokens":45');
    expect(output).toContain('"cache_read_input_tokens":6');
  });

  it('policyFor hashes every session-identifier spelling', () => {
    expect(policyFor('session_id')).toBe('hash');
    expect(policyFor('session.id')).toBe('hash');
    expect(policyFor('sessionId')).toBe('hash');
  });

  it('policyFor keeps known structural OTLP field names', () => {
    expect(policyFor('event.name')).toBe('keep');
    expect(policyFor('timeUnixNano')).toBe('keep');
  });

  it('policyFor redacts sensitive and unknown field names, including undefined', () => {
    expect(policyFor('prompt')).toBe('redact');
    expect(policyFor('file_path')).toBe('redact');
    expect(policyFor(undefined)).toBe('redact');
  });

  it('redactLine returns ok:true with a parseable line for valid JSON input', () => {
    const line = JSON.stringify({ kind: 'prompt', session_id: 'session-x' });

    const result = redactLine(line, options);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => {
        JSON.parse(result.line);
      }).not.toThrow();
    }
  });

  it('redactLine returns ok:false with a non-empty reason for invalid JSON input', () => {
    const result = redactLine('not json', options);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('collectNamedStrings agrees with redactJson', () => {
  it('does not report a numeric wrapper string that redactJson keeps', () => {
    expect(KEEP_NAMES.has('cache_read_tokens')).toBe(false);

    const attribute = {
      key: 'cache_read_tokens',
      value: { intValue: '12345678' },
    };

    const output = JSON.stringify(redactJson(attribute, options));
    expect(output).toContain('"intValue":"12345678"');

    const collected = collectNamedStrings(attribute, 8);
    expect(collected.some((sample) => sample.value === '12345678')).toBe(false);
  });

  it('reports a doubleValue and a boolValue string no differently', () => {
    const attributes = [
      { key: 'cost_usd', value: { doubleValue: '0.00123456' } },
      { key: 'is_cached', value: { boolValue: 'truthy-string-value' } },
    ];

    const output = JSON.stringify(redactJson(attributes, options));
    expect(output).toContain('"doubleValue":"0.00123456"');
    expect(output).toContain('"boolValue":"truthy-string-value"');

    const collected = collectNamedStrings(attributes, 8);
    expect(collected.some((sample) => sample.value === '0.00123456')).toBe(false);
    expect(collected.some((sample) => sample.value === 'truthy-string-value')).toBe(false);
  });

  it('still reports a real text string under its attribute key', () => {
    const PATH_VALUE = '/home/user/some-long-path';
    const attribute = { key: 'file_path', value: { stringValue: PATH_VALUE } };

    const collected = collectNamedStrings(attribute, 8);

    expect(collected.length).toBe(1);
    expect(collected[0]?.name).toBe('file_path');
    expect(collected[0]?.value).toBe(PATH_VALUE);
  });

  it('every collected string whose policy is not keep is absent after redaction', () => {
    const MARKER = 'text-attribute-marker-value';
    const envelope = {
      attributes: [
        { key: 'tool_input', value: { stringValue: MARKER } },
        { key: 'event.name', value: { stringValue: 'claude_code.user_prompt' } },
        { key: 'cache_read_tokens', value: { intValue: '87654321' } },
      ],
      timeUnixNano: '1794103594282000000',
    };

    const output = JSON.stringify(redactJson(envelope, options));
    for (const sample of collectNamedStrings(envelope, 8)) {
      if (policyFor(sample.name) === 'keep') continue;
      expect(output).not.toContain(sample.value);
    }
  });
});

describe('KEEP_NAMES covers the observed Claude Code attribute keys', () => {
  it('keeps every structural key the live recording showed', () => {
    const observedKeepKeys = [
      'event.timestamp',
      'tool_name',
      'tool_source',
      'decision',
      'source',
      'status',
      'transport_type',
      'server_scope',
      'hook_event',
      'hook_name',
      'hook_source',
      'hook_type',
      'query_source',
      'effort',
      'speed',
      'safe_mode',
      'managed_only',
      'terminal.type',
      'service.version',
      'os.type',
      'os.version',
      'host.arch',
    ];

    for (const key of observedKeepKeys) {
      expect(policyFor(key), key).toBe('keep');
    }
  });

  it('still redacts every identifying key the live recording showed', () => {
    const observedRedactKeys = [
      'user.email',
      'user.id',
      'user.account_id',
      'user.account_uuid',
      'organization.id',
      'prompt.id',
      'client_request_id',
      'message.uuid',
      'prompt',
      'response',
    ];

    for (const key of observedRedactKeys) {
      expect(policyFor(key), key).toBe('redact');
    }
  });

  it('hashes the observed session identifier key', () => {
    expect(policyFor('session.id')).toBe('hash');
  });

  it('keeps a tool name under the observed tool_name key', () => {
    const attribute = { key: 'tool_name', value: { stringValue: 'mcp__probe__ping' } };

    const output = JSON.stringify(redactJson(attribute, options));

    expect(output).toContain('"stringValue":"mcp__probe__ping"');
  });

  it('redacts an email even when it sits beside a kept key', () => {
    const EMAIL_MARKER = 'someone@example.invalid';
    const attributes = [
      { key: 'tool_name', value: { stringValue: 'Bash' } },
      { key: 'user.email', value: { stringValue: EMAIL_MARKER } },
    ];

    const output = JSON.stringify(redactJson(attributes, options));

    expect(output).not.toContain(EMAIL_MARKER);
    expect(output).toContain('x'.repeat(EMAIL_MARKER.length));
  });
});

const realOptions: RedactOptions = { hashId: realHashId };

/** Matches the 8-4-4-4-12 hexadecimal shape `src/hash.ts` produces. */
const HASH_SHAPE_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const FULL_HASH_SHAPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Matches a placeholder of any length, including the empty string. */
const PLACEHOLDER_PATTERN = /^x*$/;
/**
 * Matches a redacted object key: a run of letter-x placeholder characters,
 * optionally followed by the `-<ordinal>` collision suffix `walkJson`
 * appends when two sibling content keys of equal length would otherwise
 * collide (see `src/redact.ts`, `walkJson`'s `finalKey` computation).
 */
const REDACTED_KEY_PATTERN = /^x+(-\d+)?$/;

describe('the committed Fixture is its own proof', () => {
  const fixtureText = readFileSync('test/fixtures/events/claude-code/01.jsonl', 'utf8');
  const fixtureLines = fixtureText.split('\n').filter((line) => line.length > 0);

  it('every line parses as JSON', () => {
    expect(fixtureLines.length).toBeGreaterThan(0);

    for (const line of fixtureLines) {
      expect(() => {
        JSON.parse(line);
      }).not.toThrow();
    }
  });

  it('every string in it is kept, blanked, or a hash', () => {
    for (const line of fixtureLines) {
      const parsed: unknown = JSON.parse(line);
      const samples = collectNamedStrings(parsed, 1);

      for (const sample of samples) {
        const kept = policyFor(sample.name) === 'keep';
        const blanked = PLACEHOLDER_PATTERN.test(sample.value);
        const hashed =
          policyFor(sample.name) === 'hash' && FULL_HASH_SHAPE_PATTERN.test(sample.value);

        expect(
          kept || blanked || hashed,
          `name=${String(sample.name)} valueLength=${String(sample.value.length)}`,
        ).toBe(true);
      }
    }
  });

  it('carries no absolute path and no email address', () => {
    expect(fixtureText).not.toContain('/home/');
    expect(fixtureText).not.toContain('/Users/');
    expect(fixtureText).not.toContain('/root/');
    expect(fixtureText).not.toContain('@');
  });

  it('redacting it again changes only the hashed values', () => {
    for (const line of fixtureLines) {
      const result = redactLine(line, realOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const maskedOriginal = line.replace(HASH_SHAPE_PATTERN, 'HASH');
        const maskedReRedacted = result.line.replace(HASH_SHAPE_PATTERN, 'HASH');

        expect(maskedReRedacted).toBe(maskedOriginal);
      }
    }
  });
});

describe('no string from the real capture survives redaction', () => {
  const SINK_PATH = 'data/events.jsonl';
  const sinkExists = existsSync(SINK_PATH);
  const sinkLines = sinkExists
    ? readFileSync(SINK_PATH, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
    : [];

  it.skipIf(!sinkExists)('every sampled non-keep string is absent after redaction', () => {
    for (const line of sinkLines) {
      const parsed: unknown = JSON.parse(line);
      const samples = collectNamedStrings(parsed, 8);
      const result = redactLine(line, realOptions);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const redactedParsed: unknown = JSON.parse(result.line);
        const redactedSamples = collectNamedStrings(redactedParsed, 8);
        const redactedByName = new Map<string | undefined, Set<string>>();
        for (const redactedSample of redactedSamples) {
          const bucket = redactedByName.get(redactedSample.name) ?? new Set<string>();
          bucket.add(redactedSample.value);
          redactedByName.set(redactedSample.name, bucket);
        }

        for (const sample of samples) {
          if (policyFor(sample.name) === 'keep') continue;
          // The sink holds already-redacted lines and redaction is
          // idempotent, so re-redacting a placeholder or a hash proves
          // nothing about it.
          if (PLACEHOLDER_PATTERN.test(sample.value) || FULL_HASH_SHAPE_PATTERN.test(sample.value))
            continue;

          // Name-scoped, not line-scoped: a value may legitimately survive
          // under a different, kept name on the same line, so a whole-line
          // substring check reports false leaks.
          expect(
            redactedByName.get(sample.name)?.has(sample.value) ?? false,
            `name=${String(sample.name)} valueLength=${String(sample.value.length)}`,
          ).toBe(false);
        }
      }
    }
  });

  it.skipIf(!sinkExists)('the sink does carry material the Fixture does not', () => {
    let foundRedactable = false;

    for (const line of sinkLines) {
      const parsed: unknown = JSON.parse(line);
      const samples = collectNamedStrings(parsed, 8);

      if (samples.some((sample) => policyFor(sample.name) !== 'keep' && sample.value.length >= 8)) {
        foundRedactable = true;
        break;
      }
    }

    expect(foundRedactable).toBe(true);
  });
});

describe.skipIf(!TRANSCRIPT_FIXTURES_USABLE)(
  'the committed Transcript fixtures are their own proof (skipped when no harvested Transcript fixture is present; run pnpm harvest)',
  () => {
    const fixtureNames = listJsonlFixtureNames(TRANSCRIPT_FIXTURES_DIR);
    const fixtureFiles = fixtureNames.map((name) => ({
      name,
      text: readFileSync(join(TRANSCRIPT_FIXTURES_DIR, name), 'utf8'),
    }));
    const fixtureFilesWithLines = fixtureFiles.map((file) => ({
      ...file,
      lines: file.text.split('\n').filter((line) => line.length > 0),
    }));

    it('holds exactly 20 files', () => {
      expect(fixtureNames.length).toBe(20);
    });

    it('every line of every file parses as JSON', () => {
      for (const file of fixtureFilesWithLines) {
        expect(file.lines.length).toBeGreaterThan(0);
        for (const line of file.lines) {
          expect(() => {
            JSON.parse(line);
          }).not.toThrow();
        }
      }
    });

    it('every string in every line is kept, blanked, or a hash', () => {
      for (const file of fixtureFilesWithLines) {
        for (const line of file.lines) {
          const parsed: unknown = JSON.parse(line);
          const samples = collectNamedStrings(parsed, 1);

          for (const sample of samples) {
            const kept = policyFor(sample.name) === 'keep';
            const blanked = PLACEHOLDER_PATTERN.test(sample.value);
            const hashed =
              policyFor(sample.name) === 'hash' && FULL_HASH_SHAPE_PATTERN.test(sample.value);

            expect(
              kept || blanked || hashed,
              `name=${String(sample.name)} valueLength=${String(sample.value.length)}`,
            ).toBe(true);
          }
        }
      }
    });

    it('carries no absolute path and no email address, and no forbidden word', () => {
      for (const file of fixtureFiles) {
        expect(file.text).not.toContain('/home/');
        expect(file.text).not.toContain('/Users/');
        expect(file.text).not.toContain('/root/');
        expect(file.text).not.toContain('@');
        const forbiddenPattern = new RegExp(FORBIDDEN_WORD_PATTERN);
        expect(forbiddenPattern.test(file.text)).toBe(false);
      }
    });

    it('every key is either structural or already-redacted output', () => {
      // isContentKey judges a key over 40 characters to be content, and
      // redaction replaces a content key with a LENGTH-PRESERVING
      // placeholder, so a long source key becomes an equally long run of
      // letter-x characters that still reads as content. A fixture key is
      // therefore sound whether it is structural (isContentKey is false) or
      // is itself redacted output (REDACTED_KEY_PATTERN), never a source key.
      for (const file of fixtureFilesWithLines) {
        for (const line of file.lines) {
          const parsed: unknown = JSON.parse(line);
          const keys = collectObjectKeys(parsed);
          for (const key of keys) {
            const structural = !isContentKey(key);
            const redactedOutput = REDACTED_KEY_PATTERN.test(key);
            expect(structural || redactedOutput, `key=${key}`).toBe(true);
          }
        }
      }
    });
  },
);

describe('no string from a real Transcript survives redaction', () => {
  const sourceRoot = join(homedir(), '.claude', 'projects');
  const sourcesExist = existsSync(sourceRoot);

  /** Reads a candidate file as utf8, splitting on '\n' and dropping an empty-trim line. */
  function readLines(path: string): string[] {
    const contents = readFileSync(path, 'utf8');
    return contents.split('\n').filter((line) => line.trim() !== '');
  }

  /**
   * One directory below `sourceRoot` only: a deeper file is a subagent
   * Transcript that carries its parent's `sessionId`.
   */
  function listCandidates(): Candidate[] {
    const projectEntries = readdirSync(sourceRoot, { withFileTypes: true });
    const candidates: Candidate[] = [];

    for (const projectEntry of projectEntries) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = join(sourceRoot, projectEntry.name);
      const fileEntries = readdirSync(projectDir, { withFileTypes: true });
      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;
        const filePath = join(projectDir, fileEntry.name);
        const fileStat = statSync(filePath);
        candidates.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
      }
    }

    return candidates;
  }

  // Selection is by modification time, so a later run of this test may
  // choose a different 20 source files than the committed fixtures came
  // from. The absence assertion below still holds, because it checks
  // every sampled string against the whole committed fixture set.
  let cachedSources: ReturnType<typeof selectSessions> | undefined;

  /** Selects the 20 source files once, lazily, and reuses the result. */
  function selectedSources(): ReturnType<typeof selectSessions> {
    if (cachedSources === undefined) {
      const candidates = listCandidates();
      cachedSources = selectSessions(candidates, readLines, 20, 5);
    }
    return cachedSources;
  }

  function committedFixtureText(): string {
    const fixtureNames = listJsonlFixtureNames(TRANSCRIPT_FIXTURES_DIR);
    return fixtureNames
      .map((name) => readFileSync(join(TRANSCRIPT_FIXTURES_DIR, name), 'utf8'))
      .join('\n');
  }

  /**
   * The structures every assertion below reuses, each derived once from the
   * 20 committed fixtures: `fixtureText` is the full joined text;
   * `nonKeepFixtureValues` is every string value a fixture line carries
   * under a non-keep name (Block A already proves each one is a placeholder
   * or a hash, never source content); `keptFixtureText` is every string
   * value a fixture line carries under a keep-policy name, for example
   * `"name":"mcp__context7__..."` (SPEC.md:589 keeps a tool name with its
   * `mcp__` prefix), joined small; `fixtureKeys` is every object key a
   * fixture line carries.
   */
  interface FixtureData {
    fixtureText: string;
    nonKeepFixtureValues: Set<string>;
    fixtureKeys: Set<string>;
    keptFixtureText: string;
  }

  let cachedFixtureData: FixtureData | undefined;

  /** Builds the four Fixture-derived structures once, lazily, and caches them. */
  function fixtureData(): FixtureData {
    if (cachedFixtureData !== undefined) {
      return cachedFixtureData;
    }

    const FIXTURES_DIR = 'test/fixtures/transcripts/claude-code';
    const fixtureNames = readdirSync(FIXTURES_DIR).filter((name) => name.endsWith('.jsonl'));
    const nonKeepFixtureValues = new Set<string>();
    const fixtureKeys = new Set<string>();
    const keptValues: string[] = [];

    for (const name of fixtureNames) {
      const text = readFileSync(join(FIXTURES_DIR, name), 'utf8');
      const lines = text.split('\n').filter((line) => line.length > 0);
      for (const line of lines) {
        const parsed: unknown = JSON.parse(line);

        for (const sample of collectNamedStrings(parsed, 1)) {
          if (policyFor(sample.name) === 'keep') {
            keptValues.push(sample.value);
          } else {
            nonKeepFixtureValues.add(sample.value);
          }
        }

        for (const key of collectObjectKeys(parsed)) {
          fixtureKeys.add(key);
        }
      }
    }

    cachedFixtureData = {
      fixtureText: committedFixtureText(),
      nonKeepFixtureValues,
      fixtureKeys,
      keptFixtureText: keptValues.join('\n'),
    };
    return cachedFixtureData;
  }

  /**
   * How many of the longest distinct samples (or content keys) get the
   * expensive `fixtureText.includes` substring scan. `fixtureText` is
   * roughly 23 MB, so scanning it once per sample over every sampled
   * string would cost far too much; the longest samples are also the ones
   * a coincidental substring match cannot explain, so bounding the scan to
   * these still proves the absence claim.
   */
  const LONGEST_SAMPLE_SCAN_LIMIT = 50;

  /** Returns the `limit` longest distinct strings in `values`, longest first. */
  function longestDistinct(values: string[], limit: number): string[] {
    const distinct = [...new Set(values)];
    distinct.sort((a, b) => b.length - a.length);
    return distinct.slice(0, limit);
  }

  interface SourceSample {
    name: string | undefined;
    value: string;
  }

  interface SourceData {
    samples: SourceSample[];
    contentKeys: string[];
  }

  let cachedSourceData: SourceData | undefined;

  /**
   * Reads every selected source file once, lazily, collecting every
   * length-8-or-more named string (`samples`) and every content object key
   * (`contentKeys`) across all of them, for the three assertions below to
   * share.
   */
  function sourceData(): SourceData {
    if (cachedSourceData !== undefined) {
      return cachedSourceData;
    }

    const samples: SourceSample[] = [];
    const contentKeys: string[] = [];

    for (const source of selectedSources()) {
      for (const line of readLines(source.path)) {
        const parsed: unknown = JSON.parse(line);
        samples.push(...collectNamedStrings(parsed, 8));
        for (const key of collectObjectKeys(parsed)) {
          if (isContentKey(key)) {
            contentKeys.push(key);
          }
        }
      }
    }

    cachedSourceData = { samples, contentKeys };
    return cachedSourceData;
  }

  /** True when a sample's own text is itself already-redacted output. */
  function isAlreadyRedactedOutput(value: string): boolean {
    return PLACEHOLDER_PATTERN.test(value) || FULL_HASH_SHAPE_PATTERN.test(value);
  }

  it.skipIf(!sourcesExist)(
    'every sampled non-keep string exactly matches no non-keep fixture value',
    () => {
      const { nonKeepFixtureValues } = fixtureData();

      for (const sample of sourceData().samples) {
        // A sample whose own name context keeps it is lawfully kept by
        // SPEC.md:589, for example a tool name, and proves nothing here.
        if (policyFor(sample.name) === 'keep') continue;
        // A source line can itself be already-redacted output, and
        // redaction is idempotent, so re-testing a placeholder or a hash
        // proves nothing about it.
        if (isAlreadyRedactedOutput(sample.value)) continue;

        // This equality check is exact, not lax: the committed-fixture
        // tests above already prove every non-keep string a fixture holds
        // is a placeholder or a hash, never source content. So a source
        // sample that equals one of them is a genuine leak; no
        // coincidental match is possible, because `nonKeepFixtureValues`
        // holds nothing else.
        expect(
          nonKeepFixtureValues.has(sample.value),
          `name=${String(sample.name)} valueLength=${String(sample.value.length)}`,
        ).toBe(false);
      }
    },
  );

  it.skipIf(!sourcesExist)(
    'the longest non-keep samples do not appear as a substring of the committed fixtures',
    () => {
      const { fixtureText, keptFixtureText } = fixtureData();

      const eligibleValues = sourceData()
        .samples.filter(
          (sample) => policyFor(sample.name) !== 'keep' && !isAlreadyRedactedOutput(sample.value),
        )
        .map((sample) => sample.value);

      for (const sample of longestDistinct(eligibleValues, LONGEST_SAMPLE_SCAN_LIMIT)) {
        // The same text can sit under a keep-policy name in the fixtures
        // and under a non-keep name in the source, for example `context7`
        // under `name` inside the kept tool name `mcp__context7__...`
        // (SPEC.md:589). That occurrence is lawful, so it proves no leak.
        if (keptFixtureText.includes(sample)) continue;

        expect(fixtureText.includes(sample), `sampleLength=${String(sample.length)}`).toBe(false);
      }
    },
  );

  it.skipIf(!sourcesExist)(
    'every content key from a selected source is absent from the committed fixtures',
    () => {
      const { fixtureText, fixtureKeys } = fixtureData();
      const { contentKeys } = sourceData();

      for (const key of contentKeys) {
        expect(fixtureKeys.has(key), `keyLength=${String(key.length)}`).toBe(false);
      }

      for (const key of longestDistinct(contentKeys, LONGEST_SAMPLE_SCAN_LIMIT)) {
        expect(fixtureText.includes(key), `keyLength=${String(key.length)}`).toBe(false);
      }
    },
  );

  it.skipIf(!sourcesExist)('the selected sources do carry material the fixtures do not', () => {
    const sources = selectedSources();
    let foundRedactable = false;

    for (const source of sources) {
      const lines = readLines(source.path);
      for (const line of lines) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // A malformed source line must not break a live Transcript read.
          continue;
        }
        const samples = collectNamedStrings(parsed, 8);

        if (
          samples.some((sample) => policyFor(sample.name) !== 'keep' && sample.value.length >= 8)
        ) {
          foundRedactable = true;
          break;
        }
      }
      if (foundRedactable) break;
    }

    expect(foundRedactable).toBe(true);
  });
});

describe('isContentKey', () => {
  it('judges known structural keys as not content', () => {
    expect(isContentKey('sessionId')).toBe(false);
    expect(isContentKey('toolUseResult')).toBe(false);
    expect(isContentKey('type')).toBe(false);
    expect(isContentKey('additionalWorkingDirectories')).toBe(false);
  });

  it('judges a key of exactly 40 characters as not content', () => {
    expect(isContentKey('a'.repeat(40))).toBe(false);
  });

  it('judges a key of 41 characters as content', () => {
    expect(isContentKey('a'.repeat(41))).toBe(true);
  });

  it('judges a path-shaped key as content', () => {
    expect(isContentKey('/home/user/some/path.md')).toBe(true);
    expect(isContentKey('C:\\Users\\someone\\file.md')).toBe(true);
  });

  it('judges a key holding whitespace as content', () => {
    expect(isContentKey('two words')).toBe(true);
    expect(isContentKey('has\ttab')).toBe(true);
    expect(isContentKey('has\nnewline')).toBe(true);
  });

  it('judges the empty string as not content', () => {
    expect(isContentKey('')).toBe(false);
  });
});

describe('redactJson judges an object key', () => {
  it('replaces an absolute-path key with a same-length placeholder', () => {
    const PATH_KEY = '/home/user/some/path.md';
    const input = { [PATH_KEY]: 'value' };

    const output = redactJson(input, options);
    const outputJson = JSON.stringify(output);

    expect(outputJson).not.toContain(PATH_KEY);
    expect(isRecord(output)).toBe(true);
    if (isRecord(output)) {
      const keys = Object.keys(output);
      expect(keys.length).toBe(1);
      const [onlyKey] = keys;
      expect(onlyKey).toMatch(/^x+$/);
      expect(onlyKey?.length).toBe(PATH_KEY.length);
    }
  });

  it('replaces a long sentence key with a same-length placeholder', () => {
    const SENTENCE_KEY = 'The source document frames the repo around a single tool today';
    const input = { [SENTENCE_KEY]: 'value' };

    const output = redactJson(input, options);
    const outputJson = JSON.stringify(output);

    expect(outputJson).not.toContain(SENTENCE_KEY);
    expect(isRecord(output)).toBe(true);
    if (isRecord(output)) {
      const keys = Object.keys(output);
      expect(keys.length).toBe(1);
      const [onlyKey] = keys;
      expect(onlyKey).toMatch(/^x+$/);
    }
  });

  it('keeps a structural key verbatim', () => {
    const input = { sessionId: 'abc', additionalWorkingDirectories: [] };

    const output = redactJson(input, options);

    expect(isRecord(output)).toBe(true);
    if (isRecord(output)) {
      expect(Object.keys(output)).toEqual(['sessionId', 'additionalWorkingDirectories']);
    }
  });

  it('keeps two sibling content keys of equal length distinct', () => {
    const input = { 'a a a': 1, 'b b b': 2 };

    const output = redactJson(input, options);

    expect(isRecord(output)).toBe(true);
    if (isRecord(output)) {
      const keys = Object.keys(output);
      expect(keys.length).toBe(2);
      for (const key of keys) {
        expect(key).toMatch(/^x+(-\d+)?$/);
      }
      expect(keys[0]).not.toBe(keys[1]);
    }
  });

  it('replaces a content key nested inside an array of objects', () => {
    const PATH_KEY = '/nested/content/key.md';
    const input = { items: [{ [PATH_KEY]: 'value' }] };

    const output = redactJson(input, options);
    const outputJson = JSON.stringify(output);

    expect(outputJson).not.toContain(PATH_KEY);
  });

  it('still redacts the value under a replaced content key', () => {
    const SECRET_VALUE = 'secret-text-here';
    const input = { '/home/user/p.md': SECRET_VALUE };

    const output = redactJson(input, options);
    const outputJson = JSON.stringify(output);

    expect(outputJson).not.toContain(SECRET_VALUE);
  });

  it('keeps a structural key that names an inherited property', () => {
    const input = { constructor: 'a', toString: 'b', valueOf: 'c', type: 'd' };

    const output = redactJson(input, options);

    expect(isRecord(output)).toBe(true);
    if (isRecord(output)) {
      expect(Object.keys(output)).toEqual(['constructor', 'toString', 'valueOf', 'type']);
      const outputJson = JSON.stringify(output);
      expect(outputJson).not.toContain('-0');
      expect(outputJson).not.toContain('-1');
      expect(outputJson).not.toContain('-2');
    }
  });
});

describe('collectObjectKeys', () => {
  it('returns every object key, nested through objects and arrays', () => {
    const value = {
      top: 1,
      nested: { inner: 2, list: [{ deep: 3 }, { deeper: 4 }] },
    };

    const keys = collectObjectKeys(value);

    expect(keys).toEqual(
      expect.arrayContaining(['top', 'nested', 'inner', 'list', 'deep', 'deeper']),
    );
  });

  it('returns no array index', () => {
    const value = { list: [1, 2, 3] };

    const keys = collectObjectKeys(value);

    expect(keys).not.toContain('0');
    expect(keys).not.toContain('1');
    expect(keys).not.toContain('2');
  });

  it('returns an empty array for a primitive or null', () => {
    expect(collectObjectKeys('a string')).toEqual([]);
    expect(collectObjectKeys(42)).toEqual([]);
    expect(collectObjectKeys(null)).toEqual([]);
  });

  it('returns an empty array for an array of primitives', () => {
    expect(collectObjectKeys([1, 2, 3])).toEqual([]);
  });
});

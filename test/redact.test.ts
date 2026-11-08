import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  KEEP_NAMES,
  collectNamedStrings,
  policyFor,
  redactJson,
  redactLine,
} from '../src/redact.js';
import type { RedactOptions } from '../src/redact.js';
import { hashId as realHashId } from '../src/hash.js';

/**
 * Stub hashId: pure and deterministic, so the test depends on no
 * node:crypto. Same input always yields the same, fixed-shape output.
 */
const hashId = (value: string): string => `hashed-${String(value.length)}-${value.slice(0, 6)}`;

const options: RedactOptions = { hashId };

/** Extracts the first `{"key":"<name>","value":{"stringValue":"..."}}` payload string. */
function extractAttributeStringValue(json: string, name: string): string | undefined {
  const pattern = new RegExp(`"key":"${name}","value":\\{"stringValue":"([^"]*)"\\}`);
  return json.match(pattern)?.[1];
}

describe('redactJson over an OTLP log envelope', () => {
  const PROMPT_MARKER = 'prompt-marker-text-one';
  const PATH_MARKER = '/home/kiel/secret-path-marker-two';
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
    const PATH_VALUE = '/home/kiel/some-long-path';
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
        for (const sample of samples) {
          if (policyFor(sample.name) === 'keep') continue;

          expect(
            result.line.includes(sample.value),
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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseKindMapping } from '../src/replayer/kind-mapping.js';
import { RUNNER_RUN_END, RUNNER_RUN_START } from '../src/events/event-names.js';
import { KindSchema } from '../src/schema/index.js';

/**
 * Tests for `parseKindMapping` (not yet written, `src/replayer/kind-mapping.ts`).
 * Group A parses the real Collector configuration at
 * `compose/collector/config.yaml` and checks the five Group B `set` entries
 * it is known to hold (see that file's own comments). Group B builds a
 * hand-written two-line input to pin down the skip-on-invalid-kind rule.
 *
 * The path to the real configuration is resolved from `import.meta.url`
 * rather than a relative string, so the test does not depend on the
 * working directory the test runner was started from.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'compose', 'collector', 'config.yaml');

describe('parseKindMapping against the real Collector configuration', () => {
  const configText = readFileSync(CONFIG_PATH, 'utf8');
  const mapping = parseKindMapping(configText);

  it('returns a Map with exactly 5 entries', () => {
    expect(mapping.size).toBe(5);
  });

  it('gives every value a Kind that validates against KindSchema', () => {
    for (const value of mapping.values()) {
      const outcome = KindSchema.safeParse(value);
      expect(outcome.success, value).toBe(true);
    }
  });

  it('maps the RUNNER_RUN_END event name to the run_end Kind', () => {
    expect(mapping.get(RUNNER_RUN_END)).toBe('run_end');
  });

  it('maps the RUNNER_RUN_START event name to the run_start Kind', () => {
    expect(mapping.get(RUNNER_RUN_START)).toBe('run_start');
  });

  it('includes model_call, tool_call, and prompt among its values', () => {
    const values = new Set(mapping.values());
    expect(values.has('model_call')).toBe(true);
    expect(values.has('tool_call')).toBe(true);
    expect(values.has('prompt')).toBe(true);
  });
});

describe('parseKindMapping against a hand-written input', () => {
  it('skips a set statement whose kind is not a member of the Kind union', () => {
    const configText = [
      'set(log.attributes["kind"], "not_a_real_kind") where log.attributes["event.name"] == "x.made_up"',
      'set(log.attributes["kind"], "prompt") where log.attributes["event.name"] == "x.made_up_two"',
    ].join('\n');

    const mapping = parseKindMapping(configText);

    expect(mapping.size).toBe(1);
    expect(mapping.get('x.made_up_two')).toBe('prompt');
  });
});

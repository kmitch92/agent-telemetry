import { KindSchema } from '../schema/index.js';
import type { Kind } from '../schema/index.js';

/**
 * The Kind-from-Agent-event-name mapping lives only in
 * `compose/collector/config.yaml` (its own Group B comment, lines 37-39,
 * names itself the only place allowed to know one), because
 * `tickets.yaml:403` forbids an Agent event name from appearing anywhere
 * under `src/`. This module therefore does not hard-code a single mapping
 * of its own: it reads the Collector's `set(...) where ...` statements back
 * out of the configuration text the caller passes in, so the Replayer's
 * notion of Kind never drifts from the Normaliser's.
 */

/**
 * Matches one Group B statement:
 *   set(log.attributes["kind"], "<kind>") where log.attributes["event.name"] == "<name>"
 * wherever it sits inside `configText`, independent of the surrounding YAML
 * quoting. Capture group 1 is the Kind literal, group 2 the event name.
 * Whitespace around the comma, around `==`, and after `where` is optional,
 * so a reformatted configuration still matches.
 */
const SET_KIND_STATEMENT =
  /set\(log\.attributes\["kind"\],\s*"([^"]+)"\)\s*where\s+log\.attributes\["event\.name"\]\s*==\s*"([^"]+)"/g;

/**
 * Reads every Group B `set` statement out of `configText` and returns a Map
 * from the Agent event name to the Kind the Collector assigns it. A match
 * whose captured Kind does not validate against `KindSchema` is skipped: no
 * entry is added for it. The caller is responsible for reading the
 * configuration file and passing its text here; this function does no file
 * I/O of its own.
 */
export function parseKindMapping(configText: string): Map<string, Kind> {
  const mapping = new Map<string, Kind>();

  for (const match of configText.matchAll(SET_KIND_STATEMENT)) {
    const kindText = match[1];
    const eventName = match[2];
    if (kindText === undefined || eventName === undefined) {
      continue;
    }

    const outcome = KindSchema.safeParse(kindText);
    if (!outcome.success) {
      continue;
    }

    mapping.set(eventName, outcome.data);
  }

  return mapping;
}

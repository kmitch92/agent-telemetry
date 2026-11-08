/**
 * Pure routing catalogue for the probe server. No import from `node:*`, no
 * file or network access: lookup and scoring only.
 */

export interface CatalogueEntry {
  readonly target: string;
  readonly service: string;
  readonly keywords: readonly string[];
  readonly upstreamStatus: number;
  readonly rawBytes: number;
  readonly result: string;
}

export const FALLBACK_TARGET = 'fallback.reject';

const BILLING_ENTRY: CatalogueEntry = {
  target: 'billing.lookup_invoice',
  service: 'billing',
  keywords: ['invoice', 'billing', 'charge'],
  upstreamStatus: 200,
  rawBytes: 4096,
  result: 'invoice 00000 is settled; balance zero',
};

const ORDERS_ENTRY: CatalogueEntry = {
  target: 'orders.find_order',
  service: 'orders',
  keywords: ['order', 'purchase', 'basket'],
  upstreamStatus: 200,
  rawBytes: 3072,
  result: 'order 00000 has shipped; no action needed',
};

const DIRECTORY_ENTRY: CatalogueEntry = {
  target: 'directory.find_user',
  service: 'directory',
  keywords: ['user', 'account', 'person'],
  upstreamStatus: 200,
  rawBytes: 1024,
  result: 'user 00000 is active; profile confirmed',
};

const LOGISTICS_ENTRY: CatalogueEntry = {
  target: 'logistics.track_shipment',
  service: 'logistics',
  keywords: ['shipment', 'delivery', 'parcel'],
  upstreamStatus: 200,
  rawBytes: 2048,
  result: 'shipment 00000 is in transit; arriving soon',
};

const INVENTORY_ENTRY: CatalogueEntry = {
  target: 'inventory.check_stock',
  service: 'inventory',
  keywords: ['stock', 'inventory', 'warehouse'],
  upstreamStatus: 200,
  rawBytes: 1536,
  result: 'item 00000 is in stock; ready to ship',
};

const PRICING_ENTRY: CatalogueEntry = {
  target: 'pricing.get_quote',
  service: 'pricing',
  keywords: ['price', 'quote', 'cost'],
  upstreamStatus: 200,
  rawBytes: 512,
  result: 'quote 00000 is flat rate; no discount applies',
};

export const FALLBACK_ENTRY: CatalogueEntry = {
  target: FALLBACK_TARGET,
  service: 'none',
  keywords: [],
  upstreamStatus: 0,
  rawBytes: 0,
  result: 'the request did not match any known target',
};

/** Seven entries, in catalogue order. The seventh is the catch-all. */
export const CATALOGUE: readonly CatalogueEntry[] = [
  BILLING_ENTRY,
  ORDERS_ENTRY,
  DIRECTORY_ENTRY,
  LOGISTICS_ENTRY,
  INVENTORY_ENTRY,
  PRICING_ENTRY,
  FALLBACK_ENTRY,
];

export interface RouteChoice {
  readonly entry: CatalogueEntry;
  readonly confidence: number;
  readonly matched: boolean;
}

/**
 * Lowercases `request` once, then scores every real catalogue entry (the
 * catch-all is never scored) by how many of its keywords appear as a
 * substring. The highest score wins; a tie goes to the earlier entry,
 * because `>` (not `>=`) only replaces the current best on a strict
 * improvement, and entries are visited in catalogue order. A highest score
 * of zero routes to the catch-all with `matched: false`.
 */
export function route(request: string): RouteChoice {
  const lowered = request.toLowerCase();

  let bestEntry: CatalogueEntry = FALLBACK_ENTRY;
  let bestHits = -1;

  for (const entry of CATALOGUE) {
    if (entry.keywords.length === 0) {
      continue;
    }

    let hits = 0;
    for (const keyword of entry.keywords) {
      if (lowered.includes(keyword)) {
        hits += 1;
      }
    }

    if (hits > bestHits) {
      bestHits = hits;
      bestEntry = entry;
    }
  }

  if (bestHits <= 0) {
    return { entry: FALLBACK_ENTRY, confidence: 0, matched: false };
  }

  return { entry: bestEntry, confidence: Math.min(1, 0.6 + 0.1 * bestHits), matched: true };
}

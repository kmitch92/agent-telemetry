import { z } from 'zod';

/**
 * Schema for the Loki and the Prometheus HTTP query response, which share
 * one envelope (SPEC.md "smoke"): `status`, an optional `data` object
 * carrying a `resultType` and a `result` array, and an optional `error` /
 * `errorType` pair on failure. `QueryResultEntrySchema` covers both Loki's
 * `stream` + `values` shape and Prometheus's `metric` + `value` shape, since
 * the smoke check only counts entries and never reads their fields.
 */
export const QueryResultEntrySchema = z.object({
  metric: z.record(z.string(), z.string()).optional(),
  stream: z.record(z.string(), z.string()).optional(),
  value: z.unknown().optional(),
  values: z.array(z.unknown()).optional(),
});

export type QueryResultEntry = z.infer<typeof QueryResultEntrySchema>;

export const QueryResponseSchema = z.object({
  status: z.enum(['success', 'error']),
  data: z
    .object({
      resultType: z.enum(['vector', 'matrix', 'streams', 'scalar']),
      result: z.array(QueryResultEntrySchema),
    })
    .optional(),
  error: z.string().optional(),
  errorType: z.string().optional(),
});

export type QueryResponse = z.infer<typeof QueryResponseSchema>;

export function seriesCount(parsed: QueryResponse): number {
  return parsed.data?.result.length ?? 0;
}

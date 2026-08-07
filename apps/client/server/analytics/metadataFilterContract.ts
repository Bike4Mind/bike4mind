/**
 * The single source of truth for the User Activity metadata filter shape, shared by the
 * server query builder (server/analytics/userActivityQuery.ts) and the client filter panel
 * and request builder. Zod-only: importing userActivityQuery.ts wholesale from the client
 * would drag @bike4mind/common and @bike4mind/utils into the browser bundle.
 */
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;

/**
 * Metadata paths are interpolated into Mongo field keys, so they are allowlisted rather
 * than escaped: letters-first segments only, which rules out `$`-prefixed operators and
 * `__proto__`.
 */
export const METADATA_FIELD = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*){0,4}$/;

export const MetadataFilterSchema = z.object({
  field: z.string().max(64).regex(METADATA_FIELD),
  operator: z.enum(['equals', 'contains', 'in', 'exists', 'not_exists']),
  // Scalars only. `unknown` let a crafted object reach String(value) and throw (an object with
  // non-callable toString/valueOf has no primitive), which surfaced as a 500 rather than a 400.
  value: z.union([z.string().max(200), z.number(), z.boolean()]).optional(),
});

export type MetadataFilter = z.infer<typeof MetadataFilterSchema>;

// Annotated against MetadataFilter['operator'] so a schema enum value with no matching label
// (or vice versa) is a type error here, not a silent divergence caught only at runtime.
export const METADATA_OPERATORS: readonly { value: MetadataFilter['operator']; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'in', label: 'In' },
  { value: 'exists', label: 'Exists' },
  { value: 'not_exists', label: 'Does Not Exist' },
];

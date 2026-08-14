import { z } from 'zod';

export const QueryPaginate = z.object({
  pageSize: z.coerce.number().int().positive().prefault(5),
  pageNumber: z.coerce.number().int().positive().prefault(1),
  orgId: z.string().nullable().optional(),
});

export const QueryFilters = z
  .object({
    year: z.string().optional(),
    advisoryId: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    status: z.string().optional(),
    orgId: z.string().optional(),
    tab: z.string().optional(),
    type: z.string().optional(),
  })
  .optional();

export const TableQuery = QueryPaginate.extend({
  sort: z.string().optional(),
  filters: QueryFilters,
});

export const QueryComplexity = z.enum(['simple', 'contextual', 'complex']);
export type QueryComplexityType = z.infer<typeof QueryComplexity>;

/**
 * Boolean query parameter. Not `z.coerce.boolean()`: that is `Boolean(input)`, and query params
 * arrive as strings, so `'false'` would parse as TRUE. Accepts `true`/`'true'`/`'1'`
 * case-insensitively.
 *
 * A repeated param (`?flag=true&flag=true`) arrives from `qs` as an array; the last value wins,
 * matching how servers usually treat duplicates. Collapsing it to the default instead would be
 * wrong in the other direction - a caller who asked twice for `all=true` would silently get one
 * truncated page. `.catch` is the final guard so a malformed value cannot 422 the whole request.
 */
export const queryBool = z
  .preprocess(v => (Array.isArray(v) ? v.at(-1) : v), z.union([z.boolean(), z.string()]))
  .prefault(false)
  .transform(v => ['true', '1'].includes(String(v).toLowerCase()))
  .catch(false);

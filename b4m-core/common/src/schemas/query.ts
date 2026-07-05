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

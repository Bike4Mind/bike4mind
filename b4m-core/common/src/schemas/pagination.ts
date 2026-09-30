import { z } from 'zod';

/**
 * Query parameters for a cursor-paginated public list (CONVENTIONS.md section 8).
 *
 * `limit` is `z.coerce` because query values arrive as strings; registerContract publishes it as an
 * integer. A non-numeric, zero, or over-cap value is a 422, never silently clamped.
 */
export const PaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/**
 * The response envelope every cursor-paginated public list returns. `next_cursor` is required and
 * `null` on the last page, so a caller loops on it rather than on the page length.
 */
export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    next_cursor: z.string().nullable(),
  });

import { z } from 'zod';
import { SESSION_ORIGIN_CHANNELS } from './types/entities/SessionTypes';

export const searchSchema = z.object({
  search: z.string().optional(),
  /**
   * Optional product-surface filter for session listing. When omitted, list
   * queries return only default sessions (those with no surface); when set,
   * they return only sessions for that surface (e.g. 'libreoncology').
   */
  surface: z.string().optional(),
  pagination: z
    .object({
      page: z.coerce.number().int().positive(),
      limit: z.coerce.number().int().positive(),
    })
    .optional(),
  orderBy: z
    .object({
      field: z.string(),
      direction: z.enum(['asc', 'desc']),
    })
    .optional(),
});

/**
 * searchSchema plus the session-list filters (see SessionListFilters). Kept separate so the other
 * searchSchema consumers do not grow session-only params. `hasImages` accepts the 'true'/'false'
 * strings a query string carries.
 */
export const sessionSearchSchema = searchSchema.extend({
  origin: z.enum(SESSION_ORIGIN_CHANNELS).optional(),
  excludeOrigin: z.enum(SESSION_ORIGIN_CHANNELS).optional(),
  hasImages: z.union([z.boolean(), z.enum(['true', 'false']).transform(value => value === 'true')]).optional(),
});

export type SearchOptions<T> = {
  pagination: {
    page: number;
    limit: number;
  };
  orderBy: {
    field: keyof T;
    direction: 'asc' | 'desc';
  };
};

import { z } from 'zod';

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

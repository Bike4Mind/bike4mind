import { z } from 'zod';

export const AdminSearchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .refine(value => !/^b4m_/i.test(value) || /^b4m_live_[a-f0-9]{3,7}$/.test(value), {
      message: 'Use only the displayed API key prefix, never a full key',
    }),
});

export const AdminSearchResultSchema = z.object({
  type: z.enum(['user', 'organization', 'key']),
  id: z.string(),
  userId: z.string().optional(),
  displayName: z.string(),
  secondary: z.string(),
});
export const AdminSearchResponseSchema = z.object({ results: z.array(AdminSearchResultSchema).max(20) });
export type AdminSearchResult = z.infer<typeof AdminSearchResultSchema>;

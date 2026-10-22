import { z } from 'zod';

const CountSchema = z.number().int().nonnegative();

export const AdminActivitySummarySchema = z.object({
  windowStart: z.string().datetime(),
  windowEnd: z.string().datetime(),
  totalEvents: CountSchema,
  timeSeriesData: z.array(z.object({ date: z.string(), count: CountSchema })),
  categoryBreakdown: z.array(z.object({ category: z.string(), count: CountSchema, percentage: z.number() })),
  topEvents: z.array(z.object({ eventName: z.string(), count: CountSchema, category: z.string() })),
});

export type AdminActivitySummary = z.infer<typeof AdminActivitySummarySchema>;

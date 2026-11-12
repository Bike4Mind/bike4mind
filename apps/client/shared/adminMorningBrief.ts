import { z } from 'zod';

export const latestMorningBriefSchema = z.object({
  brief: z
    .object({
      environment: z.string(),
      day: z.string(),
      generatedAt: z.string(),
      facts: z.string(),
      summary: z.string().nullable(),
      needsHuman: z.array(z.object({ label: z.string(), href: z.string().regex(/^\/admin\?tab=\d+$/) })),
      delivery: z.enum(['ready', 'sending', 'sent', 'unconfirmed', 'unconfigured']),
    })
    .nullable(),
});

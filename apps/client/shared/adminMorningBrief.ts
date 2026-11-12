import { z } from 'zod';

// Numeric IDs are accepted only for records written before stable admin URLs were used.
const LEGACY_BRIEF_TABS: ReadonlyMap<string, string> = new Map([
  ['2', 'feedback'],
  ['12', 'waitlist'],
  ['16', 'secrets-rotation'],
  ['26', 'security-dashboard'],
  ['42', 'dlq-replay'],
  ['44', 'sre-agent'],
  ['54', 'published-pages'],
  ['58', 'model-lifecycle'],
  ['66', 'audit-log'],
  ['68', 'signup-domain-holds'],
  ['69', 'signup-risk-review'],
  ['70', 'held-signup-grants'],
  ['74', 'moderation-incidents'],
  ['75', 'disputes'],
  ['76', 'approvals'],
]);
const BRIEF_TABS = new Set(LEGACY_BRIEF_TABS.values());

export const morningBriefHrefSchema = z.string().transform((href, context) => {
  const match = /^\/admin\?tab=([a-z0-9-]+)$/.exec(href);
  const tab = match ? (LEGACY_BRIEF_TABS.get(match[1]) ?? match[1]) : undefined;
  if (!tab || !BRIEF_TABS.has(tab)) {
    context.addIssue({ code: 'custom', message: 'Invalid morning brief admin link' });
    return z.NEVER;
  }
  return `/admin?tab=${tab}`;
});

export const latestMorningBriefSchema = z.object({
  brief: z
    .object({
      environment: z.string(),
      day: z.string(),
      generatedAt: z.string(),
      facts: z.string(),
      summary: z.string().nullable(),
      needsHuman: z.array(z.object({ label: z.string(), href: morningBriefHrefSchema })),
      delivery: z.enum(['ready', 'sending', 'sent', 'unconfirmed', 'unconfigured']),
    })
    .nullable(),
});

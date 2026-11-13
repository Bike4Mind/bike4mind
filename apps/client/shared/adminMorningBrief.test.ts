import { describe, expect, it } from 'vitest';
import { morningBriefHrefSchema } from './adminMorningBrief';

describe('morning brief links', () => {
  it.each([
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
  ])('maps stored tab %s to stable %s', (legacy, slug) => {
    const canonical = `/admin?tab=${slug}`;
    expect(morningBriefHrefSchema.parse(`/admin?tab=${legacy}`)).toBe(canonical);
    expect(morningBriefHrefSchema.parse(canonical)).toBe(canonical);
  });
  it.each([
    'https://example.test/admin?tab=feedback',
    '//example.test/admin?tab=feedback',
    '/admin?tab=999',
    '/admin?tab=stripe-disputes',
    '/admin?tab=feedback&redirect=elsewhere',
    '/admin?tab=constructor',
  ])('rejects %s', href => {
    expect(morningBriefHrefSchema.safeParse(href).success).toBe(false);
  });
});

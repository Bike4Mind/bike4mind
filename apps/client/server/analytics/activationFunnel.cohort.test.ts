import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  AnalyticsUserDay: { find: () => ({ hint: () => ({ maxTimeMS: () => ({ lean: async () => [] }) }) }) },
  CREDIT_BALANCE_EVENT_TYPES: [],
  CreditTransaction: {},
  Organization: {},
  User: { find: mocks.find },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ Subscription: {} }));

import { classifyFunnelCohort, FUNNEL_COHORT_MAX, funnelStepUserIds, paidWindowOpen } from './activationFunnel';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const window = { start: new Date('2026-10-01T00:00:00.000Z'), end: new Date('2026-11-05T00:00:00.000Z') };
const options = { now: NOW, deadlineMs: 1000, needsPayments: false };
const users = (count: number, createdAt: string) =>
  Array.from({ length: count }, (_, index) => ({
    _id: `${createdAt}-${index}`,
    email: `u${index}@example.org`,
    createdAt: new Date(createdAt),
  }));

// Answers each User.find by which side of the 7-day cutoff its createdAt filter asks for.
const stubUsers = (judgeable: unknown[], tooNew: unknown[]) =>
  mocks.find.mockImplementation((filter: { createdAt: Record<string, Date> }) => {
    const { createdAt } = filter;
    const result = createdAt.$lte ? judgeable : tooNew;
    const chain = {
      select: () => chain,
      hint: () => chain,
      limit: () => chain,
      maxTimeMS: () => chain,
      lean: async () => result,
    };
    return chain;
  });

beforeEach(() => {
  mocks.find.mockReset();
});

describe('classifyFunnelCohort', () => {
  it('does not count too-new signups toward the cohort cap', async () => {
    stubUsers(users(FUNNEL_COHORT_MAX, '2026-10-10T00:00:00.000Z'), users(1500, '2026-11-02T00:00:00.000Z'));
    const { members, tooNewIds } = await classifyFunnelCohort(window, { ...options, withTooNew: true });
    expect(members).toHaveLength(FUNNEL_COHORT_MAX);
    expect(tooNewIds).toHaveLength(1500);
    await expect(funnelStepUserIds({ ...window, step: 'signedUp' }, options)).resolves.toHaveLength(FUNNEL_COHORT_MAX);
  });

  it('still refuses a judgeable window over the cap', async () => {
    stubUsers(users(FUNNEL_COHORT_MAX + 1, '2026-10-10T00:00:00.000Z'), []);
    await expect(classifyFunnelCohort(window, options)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('skips the too-new read unless asked', async () => {
    stubUsers([], users(3, '2026-11-02T00:00:00.000Z'));
    await classifyFunnelCohort(window, options);
    expect(mocks.find).toHaveBeenCalledTimes(1);
  });
});

describe('paidWindowOpen', () => {
  it('stays open through the end of the UTC day 30 days after signup', () => {
    const signupAt = new Date('2026-10-04T06:00:00.000Z');
    expect(paidWindowOpen(signupAt, new Date('2026-11-03T12:00:00.000Z'))).toBe(true);
    expect(paidWindowOpen(signupAt, new Date('2026-11-04T00:00:00.000Z'))).toBe(false);
  });
});

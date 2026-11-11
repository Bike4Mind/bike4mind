import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_PAYMENT_HISTORY_DAYS,
  AccountContextSchema,
  defaultAccountContextDeps,
  resolveAccountContexts,
  type AccountContextDeps,
  type AccountContextUser,
} from './accountContext';

const database = vi.hoisted(() => ({ userFind: vi.fn(), organizationFind: vi.fn(), paymentAggregate: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  User: { find: database.userFind },
  Organization: { find: database.organizationFind },
  PaymentAttemptModel: { aggregate: database.paymentAggregate },
}));

const NOW = new Date('2026-11-07T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);
const user = (id = 'user'): AccountContextUser => ({
  id,
  createdAt: ago(30),
  emailVerified: true,
  riskScore: { score: 12, reviewState: 'none' },
  riskEvidence: { summary: { computedAt: ago(0.5) } },
});

function createDeps(overrides: Partial<AccountContextDeps> = {}) {
  return {
    findUsers: vi.fn<AccountContextDeps['findUsers']>(async () => [user()]),
    findOrganizations: vi.fn<AccountContextDeps['findOrganizations']>(async () => []),
    findPaymentHistory: vi.fn<AccountContextDeps['findPaymentHistory']>(async () => []),
    ...overrides,
  };
}

const account = { ownerType: 'User', ownerId: 'user' } as const;

describe('resolveAccountContexts', () => {
  it('returns observed user facts without exporting identifiers or sensitive source fields', async () => {
    const deps = createDeps({
      findUsers: vi.fn(async () => [
        {
          ...user(),
          lastCreditsPurchasedAt: ago(15),
          paymentRiskEventAt: ago(2),
          riskReviewReopenedAt: ago(1),
          email: 'private@example.com',
          signupMeta: { ip: 'private' },
        },
      ]),
      findPaymentHistory: vi.fn(async () => [
        {
          userId: 'user',
          succeeded: 3,
          failed: 2,
          radarBlocked: 1,
          elevatedRisk: 1,
          latestSucceededAt: ago(3),
        },
      ]),
    });
    const contexts = await resolveAccountContexts([account], NOW, deps);
    expect(contexts.get('User:user')).toEqual({
      accountAgeDays: 30,
      responsibleAccountAgeDays: 30,
      emailVerified: true,
      reviewState: 'none',
      riskScore: 12,
      reviewReopened: true,
      banned: false,
      paymentRiskEvent: true,
      hasCreditPurchase: true,
      lastCreditPurchaseAgeDays: 15,
      payments: {
        status: 'observed',
        succeeded: 3,
        failed: 2,
        radarBlocked: 1,
        elevatedRisk: 1,
        latestSucceededAgeDays: 3,
      },
      evidence: { status: 'observed', ageHours: 12 },
    });
    expect(JSON.stringify(contexts.get('User:user'))).not.toMatch(/private|@|userId|signupMeta/);
    expect(deps.findPaymentHistory).toHaveBeenCalledExactlyOnceWith(['user'], ago(ACCOUNT_PAYMENT_HISTORY_DAYS), NOW);
  });

  it('keeps missing legacy risk, evidence and retained payment history explicitly unknown', async () => {
    const deps = createDeps({ findUsers: vi.fn(async () => [{ id: 'user', createdAt: ago(300) }]) });
    const context = (await resolveAccountContexts([account], NOW, deps)).get('User:user');
    expect(context).toMatchObject({
      accountAgeDays: 300,
      emailVerified: null,
      reviewState: 'unknown',
      riskScore: null,
      reviewReopened: false,
      banned: false,
      paymentRiskEvent: false,
      hasCreditPurchase: false,
      payments: { status: 'missing', succeeded: 0, latestSucceededAgeDays: null },
      evidence: { status: 'missing', ageHours: null },
    });
  });

  it('reports a ban on an unscored account, which carries no banned review state', async () => {
    const deps = createDeps({
      findUsers: vi.fn(async () => [{ id: 'user', createdAt: ago(300), emailVerified: true, isBanned: true }]),
    });
    const context = (await resolveAccountContexts([account], NOW, deps)).get('User:user');
    expect(context).toMatchObject({ reviewState: 'unknown', riskScore: null, banned: true });
  });

  it('does not infer a clean profile or an established age for a missing account', async () => {
    const deps = createDeps({ findUsers: vi.fn(async () => []) });
    const context = (await resolveAccountContexts([account], NOW, deps)).get('User:user');
    expect(context).toMatchObject({
      accountAgeDays: null,
      responsibleAccountAgeDays: null,
      emailVerified: null,
      reviewState: 'unknown',
      riskScore: null,
      reviewReopened: null,
      banned: null,
      paymentRiskEvent: null,
      hasCreditPurchase: null,
      lastCreditPurchaseAgeDays: null,
    });
  });

  it('uses an organization own age and credit history but its billing owner risk and payment history', async () => {
    const deps = createDeps({
      findOrganizations: vi.fn(async () => [
        { id: 'org', userId: 'owner', createdAt: ago(2), lastCreditsPurchasedAt: ago(1) },
      ]),
      findUsers: vi.fn(async () => [{ ...user('owner'), createdAt: ago(60), paymentRiskEventAt: ago(3) }]),
      findPaymentHistory: vi.fn(async () => [
        { userId: 'owner', succeeded: 2, failed: 0, radarBlocked: 0, elevatedRisk: 0, latestSucceededAt: ago(20) },
      ]),
    });
    const context = (await resolveAccountContexts([{ ownerType: 'Organization', ownerId: 'org' }], NOW, deps)).get(
      'Organization:org'
    );
    expect(context).toMatchObject({
      accountAgeDays: 2,
      responsibleAccountAgeDays: 60,
      paymentRiskEvent: true,
      lastCreditPurchaseAgeDays: 1,
      payments: { succeeded: 2 },
    });
    expect(deps.findUsers).toHaveBeenCalledExactlyOnceWith(['owner']);
    expect(deps.findPaymentHistory).toHaveBeenCalledWith(['owner'], ago(90), NOW);
  });

  it.each([
    { name: 'the organization has the stamp and the owner does not', orgStamp: ago(4), ownerStamp: undefined },
    { name: 'the owner has the stamp and the organization does not', orgStamp: undefined, ownerStamp: ago(4) },
  ])(
    'takes credit-purchase standing from the organization stamp, not the owner stamp, when $name',
    async ({ orgStamp, ownerStamp }) => {
      const deps = createDeps({
        findOrganizations: vi.fn(async () => [
          { id: 'org', userId: 'owner', createdAt: ago(30), lastCreditsPurchasedAt: orgStamp },
        ]),
        findUsers: vi.fn(async () => [{ ...user('owner'), lastCreditsPurchasedAt: ownerStamp }]),
      });
      const context = (await resolveAccountContexts([{ ownerType: 'Organization', ownerId: 'org' }], NOW, deps)).get(
        'Organization:org'
      );
      expect(context).toMatchObject(
        orgStamp
          ? { hasCreditPurchase: true, lastCreditPurchaseAgeDays: 4 }
          : { hasCreditPurchase: false, lastCreditPurchaseAgeDays: null }
      );
    }
  );

  it('batches and deduplicates shared billing owners without querying nonexistent organization owners', async () => {
    const deps = createDeps({
      findOrganizations: vi.fn(async () => [{ id: 'org', userId: 'user', createdAt: ago(2) }]),
    });
    const contexts = await resolveAccountContexts(
      [
        account,
        account,
        { ownerType: 'Organization', ownerId: 'org' },
        { ownerType: 'Organization', ownerId: 'missing-org' },
      ],
      NOW,
      deps
    );
    expect(contexts.size).toBe(3);
    expect(deps.findOrganizations).toHaveBeenCalledExactlyOnceWith(['org', 'missing-org']);
    expect(deps.findUsers).toHaveBeenCalledExactlyOnceWith(['user']);
    expect(contexts.get('Organization:missing-org')).toMatchObject({
      accountAgeDays: null,
      responsibleAccountAgeDays: null,
      reviewState: 'unknown',
      paymentRiskEvent: null,
    });
  });

  it('treats future or invalid timestamps as unknown rather than established history', async () => {
    const deps = createDeps({
      findUsers: vi.fn(async () => [
        {
          ...user(),
          createdAt: ago(-1),
          lastCreditsPurchasedAt: new Date('invalid'),
          riskEvidence: { summary: { computedAt: ago(-1) } },
        },
      ]),
    });
    const context = (await resolveAccountContexts([account], NOW, deps)).get('User:user');
    expect(context).toMatchObject({
      accountAgeDays: null,
      lastCreditPurchaseAgeDays: null,
      evidence: { status: 'missing' },
    });
  });

  it('propagates failed lookups rather than returning clean facts', async () => {
    const deps = createDeps({
      findPaymentHistory: vi.fn(async () => {
        throw new Error('payment history unavailable');
      }),
    });
    await expect(resolveAccountContexts([account], NOW, deps)).rejects.toThrow('payment history unavailable');
  });

  it('does no reads for an empty batch', async () => {
    const deps = createDeps();
    expect(await resolveAccountContexts([], NOW, deps)).toEqual(new Map());
    expect(deps.findUsers).not.toHaveBeenCalled();
    expect(deps.findOrganizations).not.toHaveBeenCalled();
    expect(deps.findPaymentHistory).not.toHaveBeenCalled();
  });

  it('rejects malformed computed facts', () => {
    const valid = {
      accountAgeDays: 1,
      responsibleAccountAgeDays: 1,
      emailVerified: true,
      reviewState: 'none',
      riskScore: null,
      reviewReopened: false,
      banned: false,
      paymentRiskEvent: false,
      hasCreditPurchase: false,
      lastCreditPurchaseAgeDays: null,
      payments: {
        status: 'missing',
        succeeded: 0,
        failed: 0,
        radarBlocked: 0,
        elevatedRisk: 0,
        latestSucceededAgeDays: null,
      },
      evidence: { status: 'missing', ageHours: null },
    };
    expect(AccountContextSchema.safeParse(valid).success).toBe(true);
    expect(AccountContextSchema.safeParse({ ...valid, accountAgeDays: -1 }).success).toBe(false);
  });
});

describe('defaultAccountContextDeps', () => {
  it('projects only the required account fields and normalizes database ids', async () => {
    const userSelect = vi
      .fn()
      .mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: '000000000000000000000001', emailVerified: true }]) });
    const organizationSelect = vi
      .fn()
      .mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: '000000000000000000000002', userId: 'owner' }]) });
    database.userFind.mockReturnValue({ select: userSelect });
    database.organizationFind.mockReturnValue({ select: organizationSelect });
    const deps = defaultAccountContextDeps();
    await expect(deps.findUsers(['invalid', '000000000000000000000001'])).resolves.toEqual([
      { _id: '000000000000000000000001', id: '000000000000000000000001', emailVerified: true },
    ]);
    expect(database.userFind).toHaveBeenCalledWith({ _id: { $in: ['000000000000000000000001'] } });
    expect(new Set(userSelect.mock.calls[0][0].split(' '))).toEqual(
      new Set([
        'createdAt',
        'emailVerified',
        'isBanned',
        'riskScore.score',
        'riskScore.reviewState',
        'riskReviewReopenedAt',
        'paymentRiskEventAt',
        'lastCreditsPurchasedAt',
        'riskEvidence.summary.computedAt',
      ])
    );
    expect(userSelect.mock.calls[0][0]).not.toMatch(/password|signupMeta|email /);
    await deps.findOrganizations(['000000000000000000000002']);
    expect(organizationSelect).toHaveBeenCalledWith('userId createdAt lastCreditsPurchasedAt');
  });

  it('reads a bounded retained payment window and returns only aggregated facts', async () => {
    const option = vi
      .fn()
      .mockResolvedValue([
        { _id: 'user', succeeded: 2, failed: 1, radarBlocked: 1, elevatedRisk: 0, latestSucceededAt: ago(2) },
      ]);
    database.paymentAggregate.mockReturnValue({ option });
    await expect(defaultAccountContextDeps().findPaymentHistory(['user'], ago(90), NOW)).resolves.toEqual([
      { userId: 'user', succeeded: 2, failed: 1, radarBlocked: 1, elevatedRisk: 0, latestSucceededAt: ago(2) },
    ]);
    const [pipeline] = database.paymentAggregate.mock.calls.at(-1) ?? [];
    expect(pipeline[0]).toEqual({
      $match: { userId: { $in: ['user'] }, createdAt: { $gte: ago(90), $lte: NOW }, paymentIntentId: { $not: /^cs_/ } },
    });
    expect(option).toHaveBeenCalledWith({ maxTimeMS: 2000 });
    expect(Object.keys(pipeline[1].$group)).toEqual([
      '_id',
      'succeeded',
      'failed',
      'radarBlocked',
      'elevatedRisk',
      'latestSucceededAt',
    ]);
  });
});

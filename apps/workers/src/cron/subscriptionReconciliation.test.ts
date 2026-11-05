import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRows: vi.fn(),
  findBySubIds: vi.fn(),
  openIds: vi.fn(),
  findOrg: vi.fn(),
  upsertOpen: vi.fn(),
  resolveMissing: vi.fn(),
  list: vi.fn(),
  retrieve: vi.fn(),
  slack: vi.fn(),
  metric: vi.fn(),
  connect: vi.fn(),
  configured: vi.fn(),
}));

const { strict } = vi.hoisted(() => {
  // Only subscriptions.list and subscriptions.retrieve exist; touching anything else throws, so a
  // Stripe write (create, update, cancel, del) fails the run instead of passing silently.
  const strict = <T extends object>(name: string, target: T): T =>
    new Proxy(target, {
      get(obj, prop) {
        if (prop in obj) return obj[prop as keyof T];
        throw new Error(`Stripe write or unexpected call: ${name}.${String(prop)}`);
      },
    });

  return { strict };
});

vi.mock('@bike4mind/database', () => ({
  connectDB: mocks.connect,
  organizationRepository: { findSeatsByStripeCustomerIds: mocks.findOrg },
  billingMismatchRepository: {
    upsertOpen: mocks.upsertOpen,
    resolveMissing: mocks.resolveMissing,
    listOpenRowFindingIds: mocks.openIds,
  },
}));
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: {
    findNonTerminalStripeRows: mocks.findRows,
    findBySubscriptionIds: mocks.findBySubIds,
  },
}));

vi.mock('@bike4mind/server-utils/integrations/stripe/stripe', () => ({
  isStripeConfigured: () => mocks.configured(),
  stripe: strict('stripe', {
    subscriptions: strict('stripe.subscriptions', { list: mocks.list, retrieve: mocks.retrieve }),
  }),
}));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.slack }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: mocks.metric }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://test/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/observability', () => {
  class MockLogger {
    withMetadata() {
      return this;
    }
    log() {}
    info() {}
    warn() {}
    error() {}
  }
  return { Logger: MockLogger };
});

import { handler, runSubscriptionReconciliation } from './subscriptionReconciliation';

const NOW = new Date('2026-11-04T06:30:00Z');
const OLD = Math.floor(NOW.getTime() / 1000) - 10 * 86_400;
const PERIOD_END = 1_802_592_000;

const stripeSub = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: 'active',
  canceled_at: null,
  currency: 'usd',
  customer: 'cus_1',
  cancel_at_period_end: false,
  cancel_at: null,
  trial_end: null,
  created: OLD,
  metadata: { stage: 'test', userId: 'user_1' },
  items: {
    data: [
      {
        price: {
          id: 'price_1',
          unit_amount: 2000,
          currency: 'usd',
          recurring: { interval: 'month', interval_count: 1 },
        },
        current_period_start: 1_800_000_000,
        current_period_end: PERIOD_END,
        quantity: 3,
      },
    ],
  },
  ...overrides,
});

const row = (subscriptionId: string, overrides: Record<string, unknown> = {}) => ({
  id: `row_${subscriptionId}`,
  subscriptionId,
  ownerType: 'User',
  ownerId: 'user_1',
  status: 'active',
  priceId: 'price_1',
  quantity: 3,
  periodEndsAt: new Date(PERIOD_END * 1000),
  cancelAtPeriodEnd: false,
  unitAmount: 2000,
  updatedAt: new Date(NOW.getTime() - 86_400_000),
  ...overrides,
});

const listing = (subs: unknown[]) => ({
  autoPagingEach: async (fn: (sub: unknown) => Promise<boolean | void>) => {
    for (const sub of subs) if ((await fn(sub)) === false) break;
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configured.mockReturnValue(true);
  mocks.upsertOpen.mockResolvedValue(true);
  mocks.resolveMissing.mockResolvedValue(0);
  mocks.findRows.mockResolvedValue([]);
  mocks.findOrg.mockResolvedValue(new Map());
  // Live rows are the ones read at the start unless a test says a row changed mid-run.
  mocks.findBySubIds.mockImplementation(async (ids: string[]) =>
    ((await mocks.findRows()) ?? []).filter((r: { subscriptionId: string }) => ids.includes(r.subscriptionId))
  );
  mocks.openIds.mockResolvedValue([]);
});

describe('runSubscriptionReconciliation', () => {
  it('finds drift and both orphan kinds using only subscriptions.list and retrieve', async () => {
    mocks.findRows.mockResolvedValue([row('sub_drift', { quantity: 1 }), row('sub_gone'), row('sub_ok')]);
    mocks.list.mockReturnValue(
      listing([
        stripeSub('sub_drift'),
        stripeSub('sub_ok'),
        stripeSub('sub_orphan'),
        stripeSub('sub_other', { metadata: { stage: 'prod' } }),
      ])
    );
    mocks.retrieve.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing' }));

    const result = await runSubscriptionReconciliation(undefined, NOW);

    expect(result.findings.map(f => [f.stripeSubscriptionId, f.kind])).toEqual([
      ['sub_orphan', 'orphan_stripe'],
      ['sub_drift', 'drift'],
      ['sub_gone', 'orphan_mongo'],
    ]);
    expect(result.findings[1].fields).toEqual([{ field: 'quantity', mongo: '1', stripe: '3' }]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledTimes(1);
    expect(mocks.retrieve).toHaveBeenCalledWith('sub_gone');
    expect(mocks.resolveMissing).toHaveBeenCalledWith(
      expect.objectContaining({ completeListing: true, seenIds: ['sub_orphan', 'sub_drift', 'sub_gone'] })
    );
    expect(mocks.slack).toHaveBeenCalledTimes(1);
    expect(mocks.slack.mock.calls[0][0]).not.toMatch(/@/);
  });

  it('records a live Stripe sub whose row is terminal as drift against that row, not an orphan', async () => {
    mocks.list.mockReturnValue(listing([stripeSub('sub_wrong')]));
    mocks.findBySubIds.mockImplementation(async (ids: string[]) =>
      ids.includes('sub_wrong') ? [row('sub_wrong', { status: 'canceled' })] : []
    );

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'drift', subscriptionRowId: 'row_sub_wrong', stripeStatus: 'active' });
    expect(findings[0].fields).toEqual([{ field: 'status', mongo: 'canceled', stripe: 'active' }]);
  });

  it('skips a canceled row against a terminal listed sub, and a row that is not Stripe-sourced', async () => {
    mocks.list.mockReturnValue(
      listing([stripeSub('sub_done', { status: 'incomplete_expired' }), stripeSub('sub_granted')])
    );
    mocks.findBySubIds.mockResolvedValue([
      row('sub_done', { status: 'canceled' }),
      row('sub_granted', { source: 'admin_grant', status: 'canceled' }),
    ]);

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toEqual([]);
  });

  describe('open findings whose row turned terminal', () => {
    beforeEach(() => {
      mocks.list.mockReturnValue(listing([]));
      mocks.openIds.mockResolvedValue(['sub_late']);
      mocks.findBySubIds.mockResolvedValue([row('sub_late', { status: 'canceled' })]);
    });

    it('covers the id when Stripe is canceled too, so resolveMissing closes it', async () => {
      mocks.retrieve.mockResolvedValue(stripeSub('sub_late', { status: 'canceled', canceled_at: OLD }));

      const { findings } = await runSubscriptionReconciliation(undefined, NOW);

      expect(findings).toEqual([]);
      expect(mocks.openIds).toHaveBeenCalledTimes(1);
      expect(mocks.resolveMissing).toHaveBeenCalledWith(
        expect.objectContaining({ coveredIds: ['sub_late'], seenIds: [], completeListing: true })
      );
    });

    it('covers the id when Stripe no longer has the subscription', async () => {
      mocks.retrieve.mockRejectedValue(Object.assign(new Error('gone'), { code: 'resource_missing' }));

      await runSubscriptionReconciliation(undefined, NOW);

      expect(mocks.resolveMissing).toHaveBeenCalledWith(expect.objectContaining({ coveredIds: ['sub_late'] }));
    });

    it('covers an unstamped sub on a non-production stage, like the phase that opened the finding', async () => {
      mocks.retrieve.mockResolvedValue(stripeSub('sub_late', { status: 'canceled', canceled_at: OLD, metadata: {} }));

      await runSubscriptionReconciliation(undefined, NOW);

      expect(mocks.resolveMissing).toHaveBeenCalledWith(expect.objectContaining({ coveredIds: ['sub_late'] }));
    });

    it('keeps the finding when Stripe still bills the subscription', async () => {
      mocks.retrieve.mockResolvedValue(stripeSub('sub_late'));

      const { findings } = await runSubscriptionReconciliation(undefined, NOW);

      expect(findings.map(f => [f.stripeSubscriptionId, f.kind])).toEqual([['sub_late', 'drift']]);
    });

    it('leaves it alone on a truncated run', async () => {
      mocks.list.mockReturnValue(listing([stripeSub('sub_x')]));
      await runSubscriptionReconciliation(undefined, NOW, Date.now() - 1);

      expect(mocks.openIds).not.toHaveBeenCalled();
      expect(mocks.resolveMissing).toHaveBeenCalledWith(
        expect.objectContaining({ coveredIds: [], completeListing: false })
      );
    });
  });

  it('flags a row Stripe now reports canceled as status drift', async () => {
    mocks.findRows.mockResolvedValue([row('sub_ended')]);
    mocks.list.mockReturnValue(listing([]));
    mocks.retrieve.mockResolvedValue(stripeSub('sub_ended', { status: 'canceled', canceled_at: OLD }));

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'drift', stripeStatus: 'canceled' });
    expect(findings[0].fields).toContainEqual({ field: 'status', mongo: 'active', stripe: 'canceled' });
  });

  it.each(['listing', 'retrieve'] as const)('leaves a recent cancellation uncovered in the %s phase', async phase => {
    mocks.findRows.mockResolvedValue([row('sub_recent')]);
    const canceled = stripeSub('sub_recent', {
      status: 'canceled',
      canceled_at: Math.floor(NOW.getTime() / 1000) - 60,
    });
    mocks.list.mockReturnValue(listing(phase === 'listing' ? [canceled] : []));
    mocks.retrieve.mockResolvedValue(canceled);

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toEqual([]);
    expect(mocks.upsertOpen).not.toHaveBeenCalled();
    expect(mocks.resolveMissing).toHaveBeenCalledWith(expect.objectContaining({ coveredIds: [] }));
  });

  it('compares organization seats with the billed quantity', async () => {
    mocks.findRows.mockResolvedValue([row('sub_org', { ownerType: 'Organization', ownerId: 'org_1' })]);
    mocks.findOrg.mockResolvedValue(new Map([['cus_1', 5]]));
    mocks.list.mockReturnValue(listing([stripeSub('sub_org')]));

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(mocks.findOrg).toHaveBeenCalledTimes(1);
    expect(mocks.findOrg).toHaveBeenCalledWith(['cus_1']);
    expect(findings[0].fields).toEqual([{ field: 'seats', mongo: '5', stripe: '3' }]);
  });

  it('drops a drift finding whose row was written while the run was listing', async () => {
    const snapshot = row('sub_a', { quantity: 1, updatedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) });
    mocks.findRows
      .mockResolvedValueOnce([snapshot])
      .mockResolvedValue([{ ...snapshot, updatedAt: new Date(NOW.getTime() - 60_000) }]);
    mocks.list.mockReturnValue(listing([stripeSub('sub_a')]));

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toEqual([]);
    expect(mocks.upsertOpen).not.toHaveBeenCalled();
  });

  it('skips rows and subscriptions inside the grace window', async () => {
    mocks.findRows.mockResolvedValue([row('sub_fresh', { quantity: 1, updatedAt: new Date(NOW.getTime() - 60_000) })]);
    mocks.list.mockReturnValue(
      listing([stripeSub('sub_fresh'), stripeSub('sub_new', { created: Math.floor(NOW.getTime() / 1000) - 60 })])
    );

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toEqual([]);
    expect(mocks.resolveMissing).toHaveBeenCalledWith(expect.objectContaining({ coveredIds: [] }));
  });

  it('on a truncated run resolves nothing it did not cover and skips the unseen-row retrieves', async () => {
    mocks.findRows.mockResolvedValue([row('sub_a'), row('sub_b')]);
    mocks.list.mockReturnValue(listing([stripeSub('sub_a'), stripeSub('sub_b')]));

    const result = await runSubscriptionReconciliation(undefined, NOW, Date.now() - 1);

    expect(result.truncated).toBe(true);
    expect(mocks.retrieve).not.toHaveBeenCalled();
    expect(mocks.resolveMissing).toHaveBeenCalledWith(
      expect.objectContaining({ coveredIds: [], completeListing: false })
    );
    expect(mocks.metric).toHaveBeenCalledWith(
      'Lumina5/Billing',
      'ReconciliationTruncated',
      1,
      expect.anything(),
      expect.anything()
    );
  });

  it('leaves a row uncovered when its retrieve fails for another reason', async () => {
    mocks.findRows.mockResolvedValue([row('sub_flaky')]);
    mocks.list.mockReturnValue(listing([]));
    mocks.retrieve.mockRejectedValue(new Error('rate limited'));

    const { findings } = await runSubscriptionReconciliation(undefined, NOW);

    expect(findings).toEqual([]);
    expect(mocks.resolveMissing).toHaveBeenCalledWith(expect.objectContaining({ coveredIds: [] }));
  });

  it('only posts to Slack when a finding is new', async () => {
    mocks.findRows.mockResolvedValue([row('sub_drift', { quantity: 1 })]);
    mocks.list.mockReturnValue(listing([stripeSub('sub_drift')]));
    mocks.upsertOpen.mockResolvedValue(false);

    await runSubscriptionReconciliation(undefined, NOW);

    expect(mocks.slack).not.toHaveBeenCalled();
    expect(mocks.metric).toHaveBeenCalledWith(
      'Lumina5/Billing',
      'SubscriptionMismatches',
      1,
      expect.anything(),
      expect.anything()
    );
  });
});

describe('handler', () => {
  it('skips when Stripe is not configured', async () => {
    mocks.configured.mockReturnValue(false);
    const res = await handler({}, { awsRequestId: 'r', getRemainingTimeInMillis: () => 600_000 } as never);
    expect(JSON.parse(res.body)).toEqual({ skipped: true });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

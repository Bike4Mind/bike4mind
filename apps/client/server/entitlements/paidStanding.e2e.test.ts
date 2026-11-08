import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreditHolderType, PAID_PLAN_ENTITLEMENT_KEY, type IUserDocument } from '@bike4mind/common';
import { AdminSettings, Organization, UsageEvent, mongoose, usageEventRepository } from '@bike4mind/database';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { checkFreeTierDailySpendCap, isFreeTierDailyCapError } from '@server/billing/freeTierDailyCapGate';
import { getUserEntitlements } from '@server/entitlements';
import { isApiKeyAccessAllowed } from '@server/utils/apiKeyAccessGate';
import { resolveUserRateTier } from '@server/utils/userRateTier';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// vitest.setup.ts allows every key by default; this suite is about the real gate.
vi.unmock('@server/utils/apiKeyAccessGate');
// Plan price ids come from per-stage env vars, so the plan map is a fixture.
vi.mock('@bike4mind/server-utils/lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {},
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

const DAY_MS = 86_400_000;
let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<
  typeof checkFreeTierDailySpendCap
>[0]['logger'];

const account = (id: string, fields: Partial<IUserDocument> = {}) =>
  ({ id, createdAt: new Date('2025-01-01T00:00:00Z'), isAdmin: false, tags: [], ...fields }) as IUserDocument;

const ACCOUNTS = {
  free: account('free-user'),
  creditBuyer: account('credit-buyer', { lastCreditsPurchasedAt: new Date('2026-10-01T00:00:00Z') }),
  // Points at the paying org but holds no users[] row: a teammate's separate personal account.
  orgPointerOnly: account('org-pointer-only', { organizationId: 'set-below' }),
  seatHolder: account('seat-holder'),
  orgManager: account('org-manager'),
};

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // Seeded before the first settings read, since the settings map is cached per process.
  await AdminSettings.create([
    { settingName: 'enforceCredits', settingValue: true },
    { settingName: 'freeTierDailySpendCapCredits', settingValue: 0 },
    { settingName: 'freeTierDailySystemCostCapUsd', settingValue: 0.1 },
    { settingName: 'apiKeyAccess', settingValue: 'paid' },
  ]);
  const org = await Organization.create({
    name: 'Paying team',
    userId: 'team-owner',
    seats: 5,
    users: [{ userId: ACCOUNTS.seatHolder.id, permissions: ['read'] }],
    adminUserIds: [ACCOUNTS.orgManager.id],
  });
  ACCOUNTS.orgPointerOnly.organizationId = String(org._id);
  await Subscription.create({
    subscriptionId: 'sub_team',
    ownerType: 'Organization',
    ownerId: String(org._id),
    priceId: 'price_team',
    status: 'active',
    source: 'stripe',
    quantity: 5,
    periodStartsAt: new Date(Date.now() - 10 * DAY_MS),
    periodEndsAt: new Date(Date.now() + 20 * DAY_MS),
  });
  // Every account is over the free system-cost cap, so only paid standing lets a turn through.
  await UsageEvent.create(
    Object.values(ACCOUNTS).map((user, index) => ({
      requestId: `paid-standing-e2e-${index}`,
      userId: user.id,
      ownerId: user.id,
      ownerType: CreditHolderType.User,
      feature: 'operations',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      source: 'system',
      status: 'ok',
      costUsd: 1,
      creditsCharged: 0,
    }))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const capped = async (user: IUserDocument): Promise<boolean> =>
  checkFreeTierDailySpendCap({ user, usageEventRepository, logger, billingOrganizationId: null }).then(
    () => false,
    (error: unknown) => {
      if (isFreeTierDailyCapError(error)) return true;
      throw error;
    }
  );

describe('paid standing across every free-tier gate, against real subscription and org reads', () => {
  it.each([
    ['a credit buyer with no plan', 'creditBuyer', true, 'basic'],
    ['an org seat holder on a Team plan', 'seatHolder', true, 'pro'],
    ['an org manager without a member row', 'orgManager', true, 'pro'],
    ['an account with no plan and no purchase', 'free', false, 'free'],
    ['an account that points at a paying org without a seat', 'orgPointerOnly', false, 'free'],
  ] as const)('%s', async (_label, key, paid, tier) => {
    const user = ACCOUNTS[key];

    expect((await getUserEntitlements(user)).includes(PAID_PLAN_ENTITLEMENT_KEY)).toBe(paid);
    expect(await resolveUserRateTier(user)).toBe(tier);
    expect(await isApiKeyAccessAllowed(user)).toBe(paid);
    expect(await capped(user)).toBe(!paid);
  });
});

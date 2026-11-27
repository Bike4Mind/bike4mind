import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, { get: (_, key) => ({ value: `test-${String(key)}` }) }),
}));
import { PAID_PLAN_ENTITLEMENT_KEY } from '@bike4mind/common';
import { Organization, mongoose } from '@bike4mind/database';
import { createModelAdmission } from '@bike4mind/services/llm/modelAdmission';
import { Subscription } from '../models/Subscription';
import { SubscriptionSource } from '../lib/subscriptions/types';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { getUserEntitlements, type EntitlementUser } from './index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Plan price ids come from per-stage env vars, so the plan map is a fixture.
vi.mock('../lib/userSubscriptions/constants', () => ({
  SUBSCRIPTION_PLANS: [],
  SUBSCRIPTION_PLANS_MAP: {},
  TEAM_PLAN: { priceId: 'price_team', tier: 2 },
}));

const DAY_MS = 86_400_000;
const PAID_MODEL = 'paid-only-model';
let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;
let paidOrgId: string;
let planlessOrgId: string;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  // Service accounts never join users[], so neither org lists them.
  const [paidOrg, planlessOrg] = await Organization.create([
    { name: 'Granted team', userId: 'paid-owner', seats: 5, users: [] },
    { name: 'No plan', userId: 'planless-owner', seats: 1, users: [] },
  ]);
  paidOrgId = String(paidOrg._id);
  planlessOrgId = String(planlessOrg._id);
  await Subscription.create({
    subscriptionId: 'admin_granted_team',
    ownerType: 'Organization',
    ownerId: paidOrgId,
    priceId: 'price_team',
    status: 'active',
    source: SubscriptionSource.AdminGrant,
    quantity: 5,
    periodStartsAt: new Date(Date.now() - 10 * DAY_MS),
    periodEndsAt: new Date(Date.now() + 20 * DAY_MS),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

const admitsPaidModel = (user: EntitlementUser): Promise<boolean> =>
  createModelAdmission({
    user,
    configs: [],
    getEntitlements: () => getUserEntitlements(user),
    freeTierAllowedModels: new Set(['free-model']),
  }).admits(PAID_MODEL);

describe('getUserEntitlements for an org service account', () => {
  it("holds its organization's admin-granted Team plan and is admitted to a paid-only model", async () => {
    const serviceAccount: EntitlementUser = { id: 'sa-paid', serviceAccountOrganizationId: paidOrgId, tags: [] };

    expect(await getUserEntitlements(serviceAccount)).toContain(PAID_PLAN_ENTITLEMENT_KEY);
    expect(await admitsPaidModel(serviceAccount)).toBe(true);
  });

  it('is still refused a paid-only model when its organization holds no plan', async () => {
    const serviceAccount: EntitlementUser = {
      id: 'sa-planless',
      serviceAccountOrganizationId: planlessOrgId,
      tags: [],
    };

    expect(await getUserEntitlements(serviceAccount)).not.toContain(PAID_PLAN_ENTITLEMENT_KEY);
    expect(await admitsPaidModel(serviceAccount)).toBe(false);
  });

  it('does not lend the org plan to an ordinary user without a seat', async () => {
    const user: EntitlementUser = { id: 'paid-org-outsider', tags: [] };

    expect(await getUserEntitlements(user)).not.toContain(PAID_PLAN_ENTITLEMENT_KEY);
    expect(await admitsPaidModel(user)).toBe(false);
  });

  it('keeps an ordinary user holding the plan through their own subscription', async () => {
    await Subscription.create({
      subscriptionId: 'sub_own_team',
      ownerType: 'User',
      ownerId: 'own-subscriber',
      priceId: 'price_team',
      status: 'active',
      source: SubscriptionSource.Stripe,
      quantity: 1,
      periodStartsAt: new Date(Date.now() - 10 * DAY_MS),
      periodEndsAt: new Date(Date.now() + 20 * DAY_MS),
    });
    const user: EntitlementUser = { id: 'own-subscriber', tags: [] };

    expect(await getUserEntitlements(user)).toContain(PAID_PLAN_ENTITLEMENT_KEY);
    expect(await admitsPaidModel(user)).toBe(true);
  });
});

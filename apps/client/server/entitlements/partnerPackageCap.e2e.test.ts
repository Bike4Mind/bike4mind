import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminSettings,
  CreditLot,
  CreditTransaction,
  GrantPackage,
  GrantPackageDayCount,
  GrantPackageRedemption,
  mongoose,
  Organization,
  PartnerSignupRule,
  User,
} from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

const grantSubscription = vi.hoisted(() =>
  vi.fn(async () => ({ status: 'granted' as const, credits: 0, currentCredits: null }))
);

vi.mock('@server/subscriptions/grantIndividualAdminSubscription', () => ({
  grantIndividualAdminSubscription: grantSubscription,
}));
vi.mock('@server/entitlements/invalidate', () => ({
  pushEntitlementInvalidation: vi.fn(async () => undefined),
  pushSubscriptionsInvalidation: vi.fn(async () => undefined),
}));
vi.mock('@server/organizations/notifySeatCeilingRaised', () => ({
  notifySeatCeilingRaised: vi.fn(async () => undefined),
  auditSeatCeilingRaised: vi.fn(async () => undefined),
  notifyPartnerSignupBlockedAtCapacity: vi.fn(async () => undefined),
}));
vi.mock('@server/premium-generated/premiumPartnerSignupHooks.generated', () => ({ premiumPartnerSignupHooks: [] }));

import { applySignupDomainGrant } from './signupDomainGrant';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const models = [
  User,
  Organization,
  PartnerSignupRule,
  CreditTransaction,
  CreditLot,
  AdminSettings,
  GrantPackage,
  GrantPackageRedemption,
  GrantPackageDayCount,
];

beforeAll(async () => {
  server = await createMongoReplSet();
  mongoose.set('transactionAsyncLocalStorage', true);
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  for (const model of models) await model.createCollection();
  await CreditTransaction.collection.createIndex({ transactionId: 1 }, { unique: true, sparse: true });
  await GrantPackageRedemption.createIndexes();
  await GrantPackageDayCount.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const model of models) await model.collection.deleteMany({});
});

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Parameters<
  typeof applySignupDomainGrant
>[0]['logger'];

describe('partner signup rule linked to a capped grant package', () => {
  it('joins every verified signup to the org and plan but credits only the first', async () => {
    const owner = await User.create({ name: 'owner', username: 'owner', email: 'owner@example.test' });
    const org = await Organization.create({ name: 'Partner Org', userId: String(owner._id), seats: 10 });
    const pkg = await GrantPackage.create({
      name: 'Synthetic partner package',
      credits: 100,
      totalCap: 1,
      dailyCap: null,
      createdBy: 'synthetic-admin',
    });
    await PartnerSignupRule.create({
      domain: 'partner.example.test',
      organizationId: String(org._id),
      signupCredits: 0,
      grantPackageId: String(pkg._id),
      subscription: { priceId: 'price_synthetic', durationMonths: 1 },
    });

    const signups = [];
    for (const name of ['first', 'second']) {
      const user = await User.create({
        name,
        username: name,
        email: `${name}@partner.example.test`,
        emailVerified: true,
        currentCredits: 0,
      });
      const result = await applySignupDomainGrant({
        userId: String(user._id),
        email: user.email,
        trigger: 'otc-signup',
        logger,
      });
      signups.push({ id: String(user._id), result });
    }

    for (const { result } of signups) expect(result.joinedOrganizationId).toBe(String(org._id));
    expect(grantSubscription).toHaveBeenCalledTimes(2);
    expect(signups.map(({ result }) => result.creditsGranted)).toEqual([100, 0]);
    expect((await User.findById(signups[0].id).lean())?.currentCredits).toBe(100);
    expect((await User.findById(signups[1].id).lean())?.currentCredits).toBe(0);

    const after = await GrantPackage.findById(pkg._id).lean();
    expect(after?.redeemedTotal).toBe(1);
    expect(after?.capHits).toBe(1);
  });
});

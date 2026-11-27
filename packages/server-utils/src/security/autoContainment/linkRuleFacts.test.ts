import { AutoContainmentConfigSchema } from '@bike4mind/common';
import type { IUserSpendProfile, UserAccountRiskProfile, UserSignupLinkCandidate } from '@bike4mind/database';
import { describe, expect, it, vi } from 'vitest';
import { loadLinkRuleFacts, type LinkRuleFactsDeps } from './linkRuleFacts';

// Plan price ids come from per-stage env vars, so which price counts as paid is a fixture.
vi.mock('../../entitlements/paidStanding', async importOriginal => ({
  ...(await importOriginal<typeof import('../../entitlements/paidStanding')>()),
  hasPaidSubscription: (subscriptions: readonly { priceId: string }[]) =>
    subscriptions.some(subscription => subscription.priceId === 'price_paid'),
}));

const HOUR_MS = 60 * 60 * 1000;
const SIGNUP = new Date('2026-11-20T10:00:00Z');
const config = AutoContainmentConfigSchema.parse({});

const account = (id: string, over: Partial<UserAccountRiskProfile> = {}): UserAccountRiskProfile => ({
  id,
  createdAt: SIGNUP,
  email: `${id}@corp-example.com`,
  signupMethod: 'otc',
  signupIp: null,
  signupJa4: null,
  signupAsnKnown: false,
  signupAsn: null,
  signupDatacenter: null,
  signupWafAnonIp: null,
  mfaEnabled: false,
  mfaSetupAt: null,
  ...over,
});

const candidate = (id: string, over: Partial<UserSignupLinkCandidate> = {}): UserSignupLinkCandidate => ({
  id,
  name: null,
  email: `${id}@corp-example.com`,
  createdAt: new Date(SIGNUP.getTime() - 2 * HOUR_MS),
  isBanned: false,
  disputePending: false,
  moderation: null,
  // A large balance is never spend evidence.
  currentCredits: 50_000,
  signupIp: null,
  signupJa4: null,
  ...over,
});

const spent = (totalCredits: number): IUserSpendProfile => ({ firstSpendAt: SIGNUP, totalCredits, byModel: [] });

function makeDeps(over: Partial<LinkRuleFactsDeps> = {}): LinkRuleFactsDeps {
  return {
    findAccountRiskProfiles: vi.fn(async (ids: string[]) => ids.map(id => account(id))),
    findCreditPurchaseStamps: vi.fn(async () => new Map<string, Date | null>()),
    findActiveSubscriptions: vi.fn(async () => []),
    isOrganizationDomain: vi.fn(async () => false),
    findAdminBlockedDomain: vi.fn(async () => null),
    findSignupLinkCandidates: vi.fn(async () => []),
    spendProfileByUsers: vi.fn(async () => ({})),
    bannedDeviceLinks: vi.fn(async () => new Map()),
    recordFactFailure: vi.fn(async () => undefined),
    ...over,
  };
}

describe('loadLinkRuleFacts', () => {
  it('counts spend since signup from usage events, and the owned-domain cluster around the account', async () => {
    const deps = makeDeps({
      findSignupLinkCandidates: vi.fn(async () => [
        candidate('c1'),
        candidate('c2', { createdAt: new Date(SIGNUP.getTime() - 5 * HOUR_MS) }),
        // Another domain that matched the query shape is not part of the cluster.
        candidate('c3', { email: 'c3@other-example.com' }),
      ]),
      spendProfileByUsers: vi.fn(async () => ({ u1: spent(30), c1: spent(5) })),
    });

    const [facts] = await loadLinkRuleFacts(['u1'], config, deps);

    expect(deps.spendProfileByUsers).toHaveBeenCalledWith(
      expect.arrayContaining(['u1', 'c1', 'c2']),
      new Date(SIGNUP.getTime() - 5 * HOUR_MS)
    );
    expect(deps.findSignupLinkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        mailDomain: 'corp-example.com',
        from: new Date(SIGNUP.getTime() - 72 * HOUR_MS),
        to: new Date(SIGNUP.getTime() + 72 * HOUR_MS),
        limit: 50,
      })
    );
    expect(facts).toEqual({
      userId: 'u1',
      paying: false,
      partnerDomain: false,
      creditsSpent: 30,
      ownedDomainCluster: { domain: 'corp-example.com', accounts: 3, spenders: 2 },
      adminHeldDomain: null,
      bannedSameDevice: 0,
    });
  });

  it('counts no spender from a balance alone', async () => {
    const deps = makeDeps({ findSignupLinkCandidates: vi.fn(async () => [candidate('c1'), candidate('c2')]) });
    const [facts] = await loadLinkRuleFacts(['u1'], config, deps);
    expect(facts.creditsSpent).toBe(0);
    expect(facts.ownedDomainCluster).toEqual({ domain: 'corp-example.com', accounts: 3, spenders: 0 });
  });

  it('has no cluster when a spending member is paying, by purchase or by subscription', async () => {
    const clustered = {
      findSignupLinkCandidates: vi.fn(async () => [candidate('c1'), candidate('c2')]),
      spendProfileByUsers: vi.fn(async () => ({ u1: spent(5), c1: spent(5), c2: spent(5) })),
    };
    const purchased = makeDeps({
      ...clustered,
      findCreditPurchaseStamps: vi.fn(async () => new Map([['c1', SIGNUP]])),
    });
    expect((await loadLinkRuleFacts(['u1'], config, purchased))[0].ownedDomainCluster).toBeNull();

    const subscribed = makeDeps({
      ...clustered,
      findActiveSubscriptions: vi.fn(async (id: string) => (id === 'c2' ? [{ priceId: 'price_paid' }] : [])),
    });
    expect((await loadLinkRuleFacts(['u1'], config, subscribed))[0].ownedDomainCluster).toBeNull();

    const unpaid = makeDeps(clustered);
    expect((await loadLinkRuleFacts(['u1'], config, unpaid))[0].ownedDomainCluster).toEqual({
      domain: 'corp-example.com',
      accounts: 3,
      spenders: 3,
    });
  });

  it('reads each standing once when the detection and the cluster share accounts', async () => {
    const deps = makeDeps({
      findSignupLinkCandidates: vi.fn(async () => [candidate('u2')]),
      spendProfileByUsers: vi.fn(async () => ({ u1: spent(5), u2: spent(5) })),
    });
    await loadLinkRuleFacts(['u1', 'u2'], config, deps);
    expect(deps.findActiveSubscriptions).toHaveBeenCalledTimes(2);
  });

  it('has no cluster on consumer mail', async () => {
    const deps = makeDeps({
      findAccountRiskProfiles: vi.fn(async () => [account('u1', { email: 'someone@gmail.com' })]),
    });
    const [facts] = await loadLinkRuleFacts(['u1'], config, deps);
    expect(facts.ownedDomainCluster).toBeNull();
    expect(deps.findSignupLinkCandidates).not.toHaveBeenCalled();
  });

  it('asks for the admin-held domain with every parent of the address', async () => {
    const findAdminBlockedDomain = vi.fn(async () => 'corp-example.com');
    const deps = makeDeps({
      findAccountRiskProfiles: vi.fn(async () => [account('u1', { email: 'x@np.corp-example.com' })]),
      findAdminBlockedDomain,
    });
    const [facts] = await loadLinkRuleFacts(['u1'], config, deps);
    expect(findAdminBlockedDomain).toHaveBeenCalledWith(['np.corp-example.com', 'corp-example.com']);
    expect(facts.adminHeldDomain).toBe('corp-example.com');
  });

  it('reads paid standing from a credit purchase or a paid subscription', async () => {
    const purchased = makeDeps({
      findCreditPurchaseStamps: vi.fn(async () => new Map([['u1', SIGNUP]])),
    });
    expect((await loadLinkRuleFacts(['u1'], config, purchased))[0].paying).toBe(true);
    expect(purchased.findActiveSubscriptions).not.toHaveBeenCalled();

    const subscribed = makeDeps({ findActiveSubscriptions: vi.fn(async () => [{ priceId: 'price_paid' }]) });
    expect((await loadLinkRuleFacts(['u1'], config, subscribed))[0].paying).toBe(true);
    expect(subscribed.findActiveSubscriptions).toHaveBeenCalledWith('u1');

    const unpaid = makeDeps({ findActiveSubscriptions: vi.fn(async () => [{ priceId: 'price_free' }]) });
    expect((await loadLinkRuleFacts(['u1'], config, unpaid))[0].paying).toBe(false);
  });

  it('reads a partner domain from the organization-domain lookup', async () => {
    const deps = makeDeps({ isOrganizationDomain: vi.fn(async () => true) });
    expect((await loadLinkRuleFacts(['u1'], config, deps))[0].partnerDomain).toBe(true);
    expect(deps.isOrganizationDomain).toHaveBeenCalledWith('u1@corp-example.com');
  });

  it('counts distinct banned device accounts outside the detection', async () => {
    const deps = makeDeps({
      bannedDeviceLinks: vi.fn(
        async () =>
          new Map([['u1', [{ blockedUserId: 'banned-1' }, { blockedUserId: 'banned-1' }, { blockedUserId: 'u2' }]]])
      ),
    });
    const facts = await loadLinkRuleFacts(['u1', 'u2'], config, deps);
    expect(facts.map(fact => [fact.userId, fact.bannedSameDevice])).toEqual([
      ['u1', 1],
      ['u2', 0],
    ]);
  });

  it('reads at most maxAccountsPerDetection accounts', async () => {
    const deps = makeDeps();
    await loadLinkRuleFacts(['a', 'b', 'c', 'd', 'e', 'f', 'a'], config, deps);
    expect(deps.findAccountRiskProfiles).toHaveBeenCalledWith(['a', 'b', 'c', 'd', 'e']);
  });

  it('fails closed per fact and logs, never throwing', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    const logger = { warn: vi.fn() };
    const deps = makeDeps({
      findCreditPurchaseStamps: vi.fn(boom),
      isOrganizationDomain: vi.fn(boom),
      findAdminBlockedDomain: vi.fn(boom),
      bannedDeviceLinks: vi.fn(boom),
      spendProfileByUsers: vi.fn(boom),
      findSignupLinkCandidates: vi.fn(async () => [candidate('c1'), candidate('c2')]),
    });
    const [facts] = await loadLinkRuleFacts(['u1'], config, deps, logger);
    expect(facts).toEqual({
      userId: 'u1',
      paying: true,
      partnerDomain: true,
      creditsSpent: 0,
      ownedDomainCluster: null,
      adminHeldDomain: null,
      bannedSameDevice: null,
    });
    expect(logger.warn).toHaveBeenCalled();
    expect(new Set(vi.mocked(deps.recordFactFailure).mock.calls.map(([fact]) => fact))).toEqual(
      new Set(['paying', 'bannedSameDevice', 'creditsSpent', 'partnerDomain', 'heldSignupDomain'])
    );

    const noAccounts = makeDeps({ findAccountRiskProfiles: vi.fn(boom) });
    expect(await loadLinkRuleFacts(['u1'], config, noAccounts, logger)).toEqual([]);
  });

  it('treats a failed subscription read as paying', async () => {
    const deps = makeDeps({
      findActiveSubscriptions: vi.fn(async () => {
        throw new Error('down');
      }),
    });
    expect((await loadLinkRuleFacts(['u1'], config, deps))[0].paying).toBe(true);
  });

  describe('spend lookback', () => {
    const DAY_MS = 24 * HOUR_MS;
    const now = new Date('2026-11-24T10:00:00Z');

    it('clamps the spend read to the last 30 days when an account signed up long ago', async () => {
      const old = new Date(now.getTime() - 400 * DAY_MS);
      const deps = makeDeps({
        findAccountRiskProfiles: vi.fn(async () => [account('u1', { createdAt: old })]),
      });
      await loadLinkRuleFacts(['u1'], config, deps, undefined, now);
      expect(deps.spendProfileByUsers).toHaveBeenCalledWith(['u1'], new Date(now.getTime() - 30 * DAY_MS));
    });

    it('reads from the earliest signup when it is recent', async () => {
      const recent = new Date(now.getTime() - 2 * DAY_MS);
      const deps = makeDeps({
        findAccountRiskProfiles: vi.fn(async () => [account('u1', { createdAt: recent })]),
      });
      await loadLinkRuleFacts(['u1'], config, deps, undefined, now);
      expect(deps.spendProfileByUsers).toHaveBeenCalledWith(['u1'], recent);
    });
  });
});

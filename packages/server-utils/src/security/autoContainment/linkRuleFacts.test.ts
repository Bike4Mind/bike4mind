import { AutoContainmentConfigSchema } from '@bike4mind/common';
import type { IUserSpendProfile, UserAccountRiskProfile, UserSignupLinkCandidate } from '@bike4mind/database';
import { describe, expect, it, vi } from 'vitest';
import { loadLinkRuleFacts, type LinkRuleFactsDeps } from './linkRuleFacts';

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
});

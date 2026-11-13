import { describe, expect, it, vi } from 'vitest';
import type { UserAccountRiskProfile, UserSignupLinkCandidate } from '@bike4mind/database';

// The loader is driven through injected reads; no repository is reachable.
vi.mock('@bike4mind/database', () => ({}));

import {
  FARM_SETUP_MINUTES,
  firedFarmSignals,
  isApiOnlySpend,
  loadFarmSignals,
  networkPeerCount,
  UNKNOWN_FARM_SIGNALS,
  type FarmSignalDeps,
  type FarmSignals,
} from './youngAccountSpendFarmSignals';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const signupAt = new Date('2026-10-26T09:00:00Z');
const window = { start: new Date('2026-10-26T10:00:00Z'), end: new Date('2026-10-26T11:00:00Z') };
const spender = {
  userId: 'user-a',
  creditsSpent: 6000,
  accountCreatedAt: signupAt,
  stripeCustomerId: null,
  email: 'a@example.com',
  currentCredits: 0,
};
const profile: UserAccountRiskProfile = {
  id: 'user-a',
  createdAt: signupAt,
  email: 'a@example.com',
  signupMethod: 'google',
  signupIp: '198.51.100.4',
  signupJa4: null,
  signupAsnKnown: true,
  signupAsn: 64500,
  signupDatacenter: false,
  signupWafAnonIp: false,
  mfaEnabled: false,
  mfaSetupAt: null,
};
const candidate = (id: string, overrides: Partial<UserSignupLinkCandidate> = {}): UserSignupLinkCandidate => ({
  id,
  name: null,
  email: null,
  createdAt: signupAt,
  isBanned: false,
  disputePending: false,
  moderation: null,
  signupIp: '198.51.100.4',
  signupJa4: null,
  ...overrides,
});

function deps(overrides: Partial<FarmSignalDeps> = {}): FarmSignalDeps {
  return {
    findAccountRiskProfiles: async () => [profile],
    findSpendChannelsByUsers: async () => ({ 'user-a': { apiCredits: 0, chatCredits: 6000 } }),
    findFirstApiKeyCreatedAt: async () => ({}),
    recentDistinctSignups: async () => ({ ipSignups: 0, asnSignups: 0, prefixSignups: 0 }),
    findSignupLinkCandidates: async () => [],
    findConfirmedAbuseUserIds: async () => [],
    isBlocked: account => account.isBanned || account.moderation?.status === 'suspended',
    now: () => window.end,
    ...overrides,
  };
}

const load = async (overrides: Partial<FarmSignalDeps> = {}, logger = { error: vi.fn() }) =>
  (await loadFarmSignals({ spenders: [spender], window, logger, deps: deps(overrides) })).get('user-a');

const only = (signals: Partial<FarmSignals>) => firedFarmSignals({ ...UNKNOWN_FARM_SIGNALS, ...signals });

describe('farm signal: API-only spend', () => {
  it('fires only when API spend has no web, CLI or desktop spend beside it', () => {
    expect(isApiOnlySpend({ apiCredits: 10, chatCredits: 0 })).toBe(true);
    expect(isApiOnlySpend({ apiCredits: 10, chatCredits: 1 })).toBe(false);
    expect(isApiOnlySpend({ apiCredits: 0, chatCredits: 0 })).toBe(false);
    expect(isApiOnlySpend(null)).toBeNull();
    expect(only({ spendChannels: { apiCredits: 10, chatCredits: 0 } })).toEqual(['apiOnlySpend']);
    expect(only({ spendChannels: { apiCredits: 10, chatCredits: 1 } })).toEqual([]);
  });

  it('reads the channels for the window, and treats a spender missing from the read as not API-only', async () => {
    const findSpendChannelsByUsers = vi.fn(async () => ({}));
    expect((await load({ findSpendChannelsByUsers }))?.spendChannels).toEqual({ apiCredits: 0, chatCredits: 0 });
    expect(findSpendChannelsByUsers).toHaveBeenCalledWith(['user-a'], window.start, window.end);
  });
});

describe('farm signal: API key soon after signup', () => {
  it(`fires at ${FARM_SETUP_MINUTES} minutes or less`, () => {
    expect(only({ minutesToApiKey: 3 })).toEqual(['apiKeySoonAfterSignup']);
    expect(only({ minutesToApiKey: FARM_SETUP_MINUTES })).toEqual(['apiKeySoonAfterSignup']);
    expect(only({ minutesToApiKey: FARM_SETUP_MINUTES + 1 })).toEqual([]);
  });

  it('measures from signup to the first key, and is unknown without a key', async () => {
    const first = new Date(signupAt.getTime() + 3 * MINUTE_MS);
    expect((await load({ findFirstApiKeyCreatedAt: async () => ({ 'user-a': first }) }))?.minutesToApiKey).toBe(3);
    expect((await load())?.minutesToApiKey).toBeNull();
  });
});

describe('farm signal: authenticator 2FA soon after signup', () => {
  it(`fires at ${FARM_SETUP_MINUTES} minutes or less`, () => {
    expect(only({ minutesToAuthenticator: 1 })).toEqual(['authenticatorSoonAfterSignup']);
    expect(only({ minutesToAuthenticator: 45 })).toEqual([]);
  });

  it('reads TOTP setup time only when TOTP is enabled', async () => {
    const setup = new Date(signupAt.getTime() + 2 * MINUTE_MS);
    const enrolled = { ...profile, mfaEnabled: true, mfaSetupAt: setup };
    expect((await load({ findAccountRiskProfiles: async () => [enrolled] }))?.minutesToAuthenticator).toBe(2);
    const abandoned = { ...profile, mfaEnabled: false, mfaSetupAt: setup };
    expect((await load({ findAccountRiskProfiles: async () => [abandoned] }))?.minutesToAuthenticator).toBeNull();
  });
});

describe('farm signal: another new account on the signup network', () => {
  it('counts an IP or /24 peer, and an ASN peer only on a datacenter or anonymizing network', () => {
    const peers = { sameIp: 0, samePrefix: 0, sameAsn: 7, anonymizingNetwork: false };
    expect(networkPeerCount(peers)).toBe(0);
    expect(only({ networkPeers: peers })).toEqual([]);
    expect(only({ networkPeers: { ...peers, anonymizingNetwork: true } })).toEqual(['youngNetworkPeer']);
    expect(only({ networkPeers: { ...peers, sameIp: 1 } })).toEqual(['youngNetworkPeer']);
    expect(only({ networkPeers: { ...peers, samePrefix: 2 } })).toEqual(['youngNetworkPeer']);
    expect(networkPeerCount({ sameIp: null, samePrefix: null, sameAsn: 3, anonymizingNetwork: false })).toBeNull();
  });

  it('asks for signups 24 hours either side of signup, capped at now, excluding the account itself', async () => {
    const recentDistinctSignups = vi.fn(async () => ({ ipSignups: 2, asnSignups: 5, prefixSignups: 3 }));
    const anonymizing = { ...profile, signupWafAnonIp: true };
    const signals = await load({ recentDistinctSignups, findAccountRiskProfiles: async () => [anonymizing] });
    expect(recentDistinctSignups).toHaveBeenCalledWith({
      userId: 'user-a',
      since: new Date(signupAt.getTime() - 24 * HOUR_MS),
      until: window.end,
      ip: '198.51.100.4',
      asn: 64500,
      maxRows: expect.any(Number),
    });
    expect(signals?.networkPeers).toEqual({ sameIp: 2, samePrefix: 3, sameAsn: 5, anonymizingNetwork: true });
  });
});

describe('farm signal: linked to a flagged account', () => {
  it('fires on any flagged linked account', () => {
    expect(only({ flaggedLinkedAccounts: 1 })).toEqual(['linkedToFlaggedAccount']);
    expect(only({ flaggedLinkedAccounts: 0 })).toEqual([]);
  });

  it('counts linked accounts that are blocked or graded confirmed abuse', async () => {
    const findSignupLinkCandidates = vi.fn(async () => [
      candidate('blocked', { moderation: { status: 'suspended' } }),
      candidate('confirmed'),
      candidate('clean'),
    ]);
    const findConfirmedAbuseUserIds = vi.fn(async () => ['confirmed']);
    const signals = await load({ findSignupLinkCandidates, findConfirmedAbuseUserIds });
    expect(signals?.flaggedLinkedAccounts).toBe(2);
    expect(findConfirmedAbuseUserIds).toHaveBeenCalledWith(['blocked', 'confirmed', 'clean']);
    expect(findSignupLinkCandidates).toHaveBeenCalledWith(
      expect.objectContaining({ excludeIds: ['user-a'], ip: '198.51.100.4', mailDomain: 'example.com' })
    );
  });
});

describe('loadFarmSignals', () => {
  it('leaves a signal unknown, and logs, when its read fails; the others still load', async () => {
    const logger = { error: vi.fn() };
    const signals = await load(
      {
        findSpendChannelsByUsers: async () => {
          throw new Error('db down');
        },
        findFirstApiKeyCreatedAt: async () => ({ 'user-a': new Date(signupAt.getTime() + MINUTE_MS) }),
      },
      logger
    );
    expect(signals?.spendChannels).toBeNull();
    expect(signals?.minutesToApiKey).toBe(1);
    expect(firedFarmSignals(signals ?? UNKNOWN_FARM_SIGNALS)).toEqual(['apiKeySoonAfterSignup']);
    expect(logger.error).toHaveBeenCalledWith(
      'young-account spend farm signal read failed: spend channels',
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it('leaves the network and link signals unknown without the account profile', async () => {
    const recentDistinctSignups = vi.fn();
    const signals = await load({ findAccountRiskProfiles: async () => [], recentDistinctSignups });
    expect(signals?.networkPeers).toBeNull();
    expect(signals?.flaggedLinkedAccounts).toBeNull();
    expect(recentDistinctSignups).not.toHaveBeenCalled();
  });

  it('fires nothing for an ordinary heavy user', async () => {
    expect(firedFarmSignals((await load()) ?? UNKNOWN_FARM_SIGNALS)).toEqual([]);
  });
});

import { abuseAssessmentAccountProfileSchema } from '@bike4mind/common';
import type { UserAccountRiskProfile, UserSignupLinkCandidate } from '@bike4mind/database';
import { describe, expect, it, vi } from 'vitest';
import {
  LINK_CANDIDATE_LIMIT,
  buildAccountProfile,
  loadAccountProfiles,
  type AccountProfileDeps,
} from './accountProfile';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SIGNUP = new Date('2026-11-01T10:00:00Z');

// The shape of a confirmed signup-farm account: VPN egress, plus-addressed webmail with a random tag,
// two-factor within minutes, the grant drained on one expensive model within the hour.
const farmAccount = (overrides: Partial<UserAccountRiskProfile> = {}): UserAccountRiskProfile => ({
  id: '65f0000000000000000000a1',
  createdAt: SIGNUP,
  email: 'jordan+x7k2q9@outlook.com',
  signupMethod: 'otc',
  signupIp: '198.51.100.4',
  signupJa4: null,
  signupAsnKnown: true,
  signupDatacenter: false,
  signupWafAnonIp: true,
  totpEnabled: true,
  mfaSetupAt: new Date(SIGNUP.getTime() + 4 * MINUTE_MS),
  ...overrides,
});

const candidate = (overrides: Partial<UserSignupLinkCandidate>): UserSignupLinkCandidate => ({
  id: '65f0000000000000000000b1',
  name: null,
  email: 'someone@gmail.com',
  createdAt: new Date(SIGNUP.getTime() - 2 * HOUR_MS),
  isBanned: false,
  disputePending: false,
  moderation: null,
  signupIp: null,
  signupJa4: null,
  ...overrides,
});

const spend = {
  firstSpendAt: new Date(SIGNUP.getTime() + 12 * MINUTE_MS),
  totalCredits: 1000,
  byModel: [
    { model: 'claude-opus-4-5', credits: 970, events: 11 },
    { model: null, credits: 30, events: 3 },
  ],
};

describe('buildAccountProfile', () => {
  it('reduces a farm-shaped account to flags, minutes and counts', () => {
    const profile = buildAccountProfile({
      account: farmAccount(),
      spend,
      links: {
        windowHours: 72,
        truncated: false,
        isBlocked: account => account.isBanned,
        candidates: [
          candidate({ id: 'b1', email: 'jordan+p3m8z1@outlook.com', isBanned: true }),
          candidate({ id: 'b2', signupIp: '198.51.100.4' }),
          // Outside the window: not counted.
          candidate({ id: 'b3', signupIp: '198.51.100.4', createdAt: new Date(SIGNUP.getTime() - 100 * HOUR_MS) }),
          // Shares nothing: not counted.
          candidate({ id: 'b4' }),
        ],
      },
    });

    expect(profile).toEqual({
      signupMethod: 'otc',
      signupNetwork: { asnKnown: true, hosting: true, datacenter: false, anonymousIp: true, ja4Present: false },
      email: { plusAddressed: true, randomLookingPlusTag: true, generatedLocalPart: false, consumerMailDomain: true },
      minutesToTwoFactor: 4,
      minutesToFirstSpend: 12,
      spend: {
        totalCredits: 1000,
        byModel: [
          { model: 'claude-opus-4-5', creditShare: 0.97, events: 11, creditsPerEvent: 88.18 },
          { model: null, creditShare: 0.03, events: 3, creditsPerEvent: 10 },
        ],
      },
      linkedAccounts: {
        windowHours: 72,
        total: 2,
        blocked: 1,
        sharedSignupIp: 1,
        sharedJa4: 0,
        sharedMailbox: 1,
        sharedMailDomain: 0,
        truncated: false,
      },
    });
    // What leaves for the provider must satisfy the strict contract.
    expect(abuseAssessmentAccountProfileSchema.parse(profile)).toEqual(profile);
  });

  it('carries no address, IP, fingerprint or account id', () => {
    const profile = buildAccountProfile({
      account: farmAccount({ signupJa4: 't13d1516h2_secret' }),
      spend,
      links: { windowHours: 72, truncated: false, isBlocked: () => false, candidates: [candidate({ id: 'b1' })] },
    });
    const serialized = JSON.stringify(profile);
    for (const secret of ['jordan', 'outlook', '198.51.100.4', 't13d1516h2_secret', '65f0000000000000000000a1']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('leaves unknowns null: no two-factor, no spend, an unchecked network, unread links', () => {
    expect(
      buildAccountProfile({
        account: farmAccount({
          totpEnabled: false,
          signupMethod: 'google',
          signupDatacenter: null,
          signupWafAnonIp: null,
          email: null,
        }),
        spend: null,
        links: null,
      })
    ).toEqual({
      signupMethod: 'oauth',
      signupNetwork: { asnKnown: true, hosting: null, datacenter: null, anonymousIp: null, ja4Present: false },
      email: null,
      minutesToTwoFactor: null,
      minutesToFirstSpend: null,
      spend: null,
      linkedAccounts: null,
    });
  });

  it('reads a residential signup as not hosting', () => {
    const profile = buildAccountProfile({
      account: farmAccount({ signupDatacenter: false, signupWafAnonIp: false }),
      spend: null,
      links: null,
    });
    expect(profile.signupNetwork.hosting).toBe(false);
  });
});

describe('loadAccountProfiles', () => {
  const deps = (overrides: Partial<AccountProfileDeps> = {}): AccountProfileDeps => ({
    findAccountRiskProfiles: vi.fn().mockResolvedValue([farmAccount()]),
    spendProfileByUsers: vi.fn().mockResolvedValue({ '65f0000000000000000000a1': spend }),
    findSignupLinkCandidates: vi.fn().mockResolvedValue([]),
    loadLinkWindowHours: vi.fn().mockResolvedValue(72),
    isBlocked: () => false,
    now: () => new Date('2026-11-02T00:00:00Z'),
    ...overrides,
  });

  it('searches the strong-link window around signup by IP, mailbox and company domain', async () => {
    const d = deps();
    const profiles = await loadAccountProfiles(['65f0000000000000000000a1'], d);
    expect(d.findSignupLinkCandidates).toHaveBeenCalledWith({
      excludeIds: ['65f0000000000000000000a1'],
      from: new Date(SIGNUP.getTime() - 72 * HOUR_MS),
      to: new Date(SIGNUP.getTime() + 72 * HOUR_MS),
      ip: '198.51.100.4',
      ja4: null,
      mailbox: { local: 'jordan', domains: ['outlook.com'], ignoreDots: false },
      // Webmail: a shared domain links nothing.
      mailDomain: null,
      limit: LINK_CANDIDATE_LIMIT,
    });
    expect(profiles.get('65f0000000000000000000a1')?.minutesToFirstSpend).toBe(12);
  });

  it('marks a full candidate page as truncated', async () => {
    const full = Array.from({ length: LINK_CANDIDATE_LIMIT }, (_, index) =>
      candidate({ id: `c${index}`, signupIp: '198.51.100.4' })
    );
    const profiles = await loadAccountProfiles(
      ['65f0000000000000000000a1'],
      deps({ findSignupLinkCandidates: vi.fn().mockResolvedValue(full) })
    );
    expect(profiles.get('65f0000000000000000000a1')?.linkedAccounts).toMatchObject({
      total: LINK_CANDIDATE_LIMIT,
      truncated: true,
    });
  });

  it('keeps the rest of the profile when the linked-account read fails', async () => {
    const profiles = await loadAccountProfiles(
      ['65f0000000000000000000a1'],
      deps({ findSignupLinkCandidates: vi.fn().mockRejectedValue(new Error('timeout')) })
    );
    expect(profiles.get('65f0000000000000000000a1')).toMatchObject({ linkedAccounts: null, minutesToTwoFactor: 4 });
  });
});

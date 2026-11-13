import { describe, expect, it, vi } from 'vitest';
import type { UserSignupLinkFacts } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({
  loadDeviceLinkAccounts: vi.fn(),
  usageEventRepository: {},
  userRepository: {},
}));
vi.mock('@bike4mind/services', () => ({ userService: {} }));
vi.mock('@bike4mind/server-utils/billing/linkedAccounts', () => ({ findLinkedAccounts: vi.fn() }));
vi.mock('@server/security/autoContainment/deviceLinkEvaluation', () => ({
  DEFAULT_DEVICE_LINK_CONFIG: { windowHours: 168, commonNetworks: 5 },
  evaluateDeviceLinks: vi.fn(),
  liveDeviceLinkReaders: {},
}));
vi.mock('@server/security/autoContainment/config', () => ({ loadAutoContainmentConfig: vi.fn() }));

import type { LinkedAccount } from '@bike4mind/server-utils/billing/linkedAccounts';
import { loadDeviceLinkAccounts } from '@bike4mind/database';
import { loadAutoContainmentConfig } from '@server/security/autoContainment/config';
import { evaluateDeviceLinks } from '@server/security/autoContainment/deviceLinkEvaluation';
import {
  buildLinkedAccountEvidence,
  liveLinkedAccountEvidenceDeps,
  type LinkedAccountEvidenceDeps,
} from './linkedAccountEvidence';

const HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-11-05T10:00:00Z');

const fact = (overrides: Partial<UserSignupLinkFacts>): UserSignupLinkFacts => ({
  id: 'u1',
  createdAt: NOW,
  signupIp: '203.0.113.7',
  signupDatacenter: false,
  signupMethod: 'google',
  landingNotebookOwnerId: null,
  ...overrides,
});

const link = (overrides: Partial<LinkedAccount>): LinkedAccount => ({
  id: 'x',
  name: null,
  email: null,
  createdAt: new Date(NOW.getTime() - 3 * HOUR_MS),
  isBanned: false,
  disputePending: false,
  moderation: null,
  strength: 'weak',
  via: ['signupNetwork'],
  blocked: false,
  ...overrides,
});

const signalsOf = (evidence: Awaited<ReturnType<typeof buildLinkedAccountEvidence>>) =>
  Object.fromEntries((evidence?.signals ?? []).map(({ key, value }) => [key, value]));

function makeDeps(overrides: Partial<LinkedAccountEvidenceDeps> = {}): LinkedAccountEvidenceDeps {
  return {
    findSignupLinkFacts: async () => [
      fact({ id: 'u1', landingNotebookOwnerId: 'owner' }),
      fact({ id: 'u2', signupMethod: 'otc', signupDatacenter: true, signupIp: null }),
    ],
    findLinkedAccounts: async () => [
      link({ id: 'blocked-1', blocked: true }),
      link({ id: 'free-1' }),
      link({ id: 'card-1', via: ['card'], strength: 'strong' }),
      // The detection's own accounts are not extra evidence.
      link({ id: 'u2', blocked: true }),
    ],
    blockedStates: async () => new Map([['owner', true]]),
    largestSettlementOverHold: async () => ({
      u1: { reservedCredits: 100, settledCredits: 4_000, ratio: 40 },
      u2: { reservedCredits: 50, settledCredits: 60, ratio: 1.2 },
    }),
    bannedDeviceLinks: async () =>
      new Map([
        [
          'u1',
          [
            { blockedUserId: 'banned-1', hoursApart: 27 },
            // A member banned since the detection is the detection, not extra evidence.
            { blockedUserId: 'u2', hoursApart: 1 },
          ],
        ],
        ['u2', [{ blockedUserId: 'banned-1', hoursApart: 30 }]],
      ]),
    now: () => NOW,
    ...overrides,
  };
}

describe('buildLinkedAccountEvidence', () => {
  it('summarizes links, landing, settlement and signup facts as counts and flags', async () => {
    const evidence = await buildLinkedAccountEvidence(
      ['u1', 'u2'],
      id => (id === 'u1' ? 'acct_1' : 'acct_2'),
      makeDeps()
    );
    expect(evidence).toMatchObject({
      source: 'linkedAccounts',
      version: 2,
      memberCount: 2,
      memberRefs: ['acct_1', 'acct_2'],
    });
    expect(signalsOf(evidence)).toEqual({
      maxSameSignupIpAccounts: 2,
      sameSignupIpBlockedAccounts: 1,
      hoursToBlockedSignupIpAccount: 3,
      sameCardAccounts: 1,
      landedOnOtherAccountNotebook: true,
      landedOnBlockedAccountNotebook: true,
      sameDeviceBannedAccounts: 1,
      hoursToBannedSameDeviceAccount: 27,
      maxSettlementOverHoldRatio: 40,
      maxSettlementOverHoldCredits: 3_900,
      oauthSignups: 1,
      emailSignups: 1,
      datacenterSignups: 1,
    });
  });

  it('keeps the other evidence when the device read fails', async () => {
    const evidence = await buildLinkedAccountEvidence(
      ['u1', 'u2'],
      id => id,
      makeDeps({ bannedDeviceLinks: async () => Promise.reject(new Error('read down')) })
    );
    expect(signalsOf(evidence)).toMatchObject({
      maxSameSignupIpAccounts: 2,
      sameCardAccounts: 1,
      sameDeviceBannedAccounts: null,
      hoursToBannedSameDeviceAccount: null,
    });
  });

  it('reports unknown rather than zero when nothing was observed', async () => {
    const evidence = await buildLinkedAccountEvidence(
      ['u1'],
      () => 'acct_1',
      makeDeps({
        findSignupLinkFacts: async () => [fact({})],
        findLinkedAccounts: async () => [],
        largestSettlementOverHold: async () => ({}),
        bannedDeviceLinks: async () => new Map(),
      })
    );
    expect(signalsOf(evidence)).toMatchObject({
      maxSameSignupIpAccounts: 0,
      sameDeviceBannedAccounts: 0,
      hoursToBannedSameDeviceAccount: null,
      hoursToBlockedSignupIpAccount: null,
      landedOnOtherAccountNotebook: false,
      maxSettlementOverHoldRatio: null,
      maxSettlementOverHoldCredits: null,
    });
  });

  it('returns null for a detection with no accounts', async () => {
    expect(await buildLinkedAccountEvidence([], () => null, makeDeps())).toBeNull();
  });
});

describe('liveLinkedAccountEvidenceDeps.bannedDeviceLinks', () => {
  const configWith = (deviceLinkWindowHours: number, deviceLinkCommonNetworks: number) =>
    ({ deviceLinkWindowHours, deviceLinkCommonNetworks }) as unknown as Awaited<
      ReturnType<typeof loadAutoContainmentConfig>
    >;

  it('evaluates with the configured window and common-network threshold', async () => {
    vi.mocked(loadAutoContainmentConfig).mockResolvedValueOnce(configWith(24, 9));
    vi.mocked(loadDeviceLinkAccounts).mockResolvedValueOnce([]);
    vi.mocked(evaluateDeviceLinks).mockResolvedValueOnce(new Map());

    await liveLinkedAccountEvidenceDeps.bannedDeviceLinks(['u1']);

    expect(evaluateDeviceLinks).toHaveBeenLastCalledWith([], { windowHours: 24, commonNetworks: 9 }, expect.anything());
  });

  it('falls back to the default window when the rule is switched off with a zero window', async () => {
    vi.mocked(loadAutoContainmentConfig).mockResolvedValueOnce(configWith(0, 7));
    vi.mocked(loadDeviceLinkAccounts).mockResolvedValueOnce([]);
    vi.mocked(evaluateDeviceLinks).mockResolvedValueOnce(new Map());

    await liveLinkedAccountEvidenceDeps.bannedDeviceLinks(['u1']);

    expect(evaluateDeviceLinks).toHaveBeenLastCalledWith(
      [],
      { windowHours: 168, commonNetworks: 7 },
      expect.anything()
    );
  });
});

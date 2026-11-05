import { describe, expect, it, vi } from 'vitest';
import type { UserSignupLinkFacts } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({ cacheRepository: {}, shadowDetectionRepository: {}, userRepository: {} }));
vi.mock('@server/billing/linkedAccounts', () => ({ findLinkedAccounts: vi.fn() }));
vi.mock('@server/security/abuseAssessment/abuseAssessment', () => ({ assessShadowDetection: vi.fn() }));
vi.mock('@server/security/abuseAssessment/linkedAccountEvidence', () => ({ linkedAccountGroupEvidence: vi.fn() }));
vi.mock('./executor', () => ({
  applyAutoContainment: vi.fn(),
  liveAutoContainmentDeps: vi.fn(),
  loadAutoContainmentConfig: vi.fn(),
}));

import type { LinkedAccount } from '@server/billing/linkedAccounts';
import { buildStrongLinkDetection, checkStrongLink, strongLinks, type StrongLinkDeps } from './strongLink';

const HOUR_MS = 60 * 60 * 1000;
const SIGNUP = new Date('2026-11-05T10:00:00Z');

const account: UserSignupLinkFacts = {
  id: 'new-user',
  createdAt: SIGNUP,
  signupIp: '203.0.113.7',
  signupDatacenter: false,
  signupMethod: 'google',
  landingNotebookOwnerId: null,
};

const link = (overrides: Partial<LinkedAccount>): LinkedAccount => ({
  id: 'other',
  name: null,
  email: null,
  createdAt: new Date(SIGNUP.getTime() - 5 * HOUR_MS),
  isBanned: true,
  disputePending: false,
  moderation: null,
  strength: 'weak',
  via: ['signupNetwork'],
  blocked: true,
  ...overrides,
});

describe('strongLinks', () => {
  it('keeps only blocked accounts on the same signup IP inside the window', () => {
    const links = [
      link({ id: 'close' }),
      link({ id: 'far', createdAt: new Date(SIGNUP.getTime() - 100 * HOUR_MS) }),
      link({ id: 'not-blocked', blocked: false }),
      link({ id: 'card-only', via: ['card'] }),
      link({ id: 'no-date', createdAt: null }),
    ];
    expect(strongLinks(account, links, 72).map(found => found.id)).toEqual(['close']);
  });
});

describe('buildStrongLinkDetection', () => {
  it('records a containment detection for the new account without its IP', () => {
    const detection = buildStrongLinkDetection(account, [link({}), link({ id: 'b', createdAt: SIGNUP })], 72, SIGNUP);
    expect(detection).toMatchObject({
      detector: 'signupIpLinkedToBlocked',
      wouldAction: 'contain',
      userIds: ['new-user'],
      network: null,
      summary: 'Signed up from the same IP as 2 blocked accounts, the closest 0 hours apart',
      windowMinutes: 72 * 60,
    });
  });
});

function makeDeps(overrides: Partial<StrongLinkDeps> = {}) {
  return {
    loadWindowHours: vi.fn(async () => 72 as number | null),
    findSignupLinkFacts: vi.fn(async () => [account]),
    findLinkedAccounts: vi.fn(async () => [link({})]),
    claimOnce: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => undefined),
    recordDetection: vi.fn(async () => 'detection-1'),
    assessAndContain: vi.fn(async () => ({ assessed: true, contained: true })),
    now: () => SIGNUP,
    ...overrides,
  } satisfies StrongLinkDeps;
}

describe('checkStrongLink', () => {
  it('records a detection and assesses it at once', async () => {
    const deps = makeDeps();
    expect(await checkStrongLink('new-user', deps)).toEqual({
      status: 'recorded',
      detectionId: 'detection-1',
      assessed: true,
      contained: true,
    });
    expect(deps.findLinkedAccounts).toHaveBeenCalledWith({ id: 'new-user', signupMeta: { ip: '203.0.113.7' } });
    expect(deps.assessAndContain).toHaveBeenCalledWith('detection-1');
  });

  it('skips when off, without a signup IP, without a strong link, or when already recorded', async () => {
    expect(await checkStrongLink('new-user', makeDeps({ loadWindowHours: async () => null }))).toEqual({
      status: 'skipped',
      reason: 'disabled',
    });
    expect(
      await checkStrongLink('new-user', makeDeps({ findSignupLinkFacts: async () => [{ ...account, signupIp: null }] }))
    ).toEqual({ status: 'skipped', reason: 'no_signup_ip' });
    expect(
      await checkStrongLink('new-user', makeDeps({ findLinkedAccounts: async () => [link({ blocked: false })] }))
    ).toEqual({
      status: 'skipped',
      reason: 'no_strong_link',
    });
    const claimed = makeDeps({ claimOnce: async () => false });
    expect(await checkStrongLink('new-user', claimed)).toEqual({ status: 'skipped', reason: 'already_recorded' });
    expect(claimed.recordDetection).not.toHaveBeenCalled();
  });

  it('releases its claim when the detection is not written, so a retry records it', async () => {
    const deps = makeDeps({ recordDetection: vi.fn(async () => Promise.reject(new Error('write failed'))) });
    await expect(checkStrongLink('new-user', deps)).rejects.toThrow('write failed');
    expect(deps.releaseClaim).toHaveBeenCalledWith('new-user');
    expect(deps.assessAndContain).not.toHaveBeenCalled();
  });
});

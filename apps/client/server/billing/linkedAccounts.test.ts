import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  linkKeysForUser: vi.fn(),
  findLinkedUserIds: vi.fn(),
  findIdsBySignupIp: vi.fn(),
  findLinkStatesByIds: vi.fn(),
  findById: vi.fn(),
  claimStep: vi.fn(),
  flagDisputePending: vi.fn(),
  postMessageToSlack: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  realtimeConnectionRepository: {},
  paymentAttemptRepository: { linkKeysForUser: mocks.linkKeysForUser, findLinkedUserIds: mocks.findLinkedUserIds },
  paymentRiskActionRepository: { claimStep: mocks.claimStep },
  userRepository: {
    findById: mocks.findById,
    findIdsBySignupIp: mocks.findIdsBySignupIp,
    findLinkStatesByIds: mocks.findLinkStatesByIds,
  },
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/services')>();
  return { userService: { ...actual.userService, flagDisputePending: mocks.flagDisputePending } };
});
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => mocks.settings,
}));
vi.mock('@bike4mind/server-utils/auth/signupNetworkSignals', () => ({
  hashSignupNetwork: (ip: string | null) => ({ ipHash: ip ? `hash:${ip}` : null, prefixHash: null }),
}));
// Loaded through subscriptionLifecycle (admin links); its model needs a real mongoose.
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({ subscriptionRepository: {} }));
vi.mock('@bike4mind/server-utils/integrations/slack/slack', () => ({ postMessageToSlack: mocks.postMessageToSlack }));

import { findLinkedAccounts, lockIfPaidWithBlockedCard, propagateAccountRisk } from './linkedAccounts';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const state = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: `User ${id}`,
  email: null,
  createdAt: new Date('2026-10-30T00:00:00Z'),
  isBanned: false,
  disputePending: false,
  moderation: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {};
  mocks.linkKeysForUser.mockResolvedValue({ cardFingerprints: ['fp_1'], ipHashes: ['hash:pay'] });
  mocks.findLinkedUserIds.mockResolvedValue({ byCard: ['u2'], byNetwork: ['u2', 'u3'] });
  mocks.findIdsBySignupIp.mockResolvedValue(['u4']);
  mocks.findLinkStatesByIds.mockImplementation(async (ids: string[]) => ids.map(id => state(id)));
  mocks.findById.mockResolvedValue({ id: 'u1', signupMeta: { ip: '198.51.100.1' }, disputePending: true });
  mocks.claimStep.mockResolvedValue(true);
  mocks.flagDisputePending.mockResolvedValue({ deactivatedKeys: true });
});

describe('findLinkedAccounts', () => {
  it('links by card (strong) and by payment or signup IP (weak), strong first', async () => {
    const linked = await findLinkedAccounts(
      { id: 'u1', signupMeta: { ip: '198.51.100.1' } },
      { extraIpHashes: ['hash:now'] }
    );

    expect(mocks.findLinkedUserIds).toHaveBeenCalledWith({
      userId: 'u1',
      cardFingerprints: ['fp_1'],
      ipHashes: ['hash:pay', 'hash:198.51.100.1', 'hash:now'],
      limit: 25,
    });
    expect(mocks.findIdsBySignupIp).toHaveBeenCalledWith('198.51.100.1', 'u1', 25);
    expect(linked.map(({ id, strength, via }) => ({ id, strength, via }))).toEqual([
      { id: 'u2', strength: 'strong', via: ['card', 'paymentNetwork'] },
      { id: 'u3', strength: 'weak', via: ['paymentNetwork'] },
      { id: 'u4', strength: 'weak', via: ['signupNetwork'] },
    ]);
  });

  it('marks a banned, disputed or suspended account as blocked', async () => {
    mocks.findLinkStatesByIds.mockResolvedValue([
      state('u2', { moderation: { status: 'suspended' } }),
      state('u3', { moderation: { status: 'throttled' } }),
    ]);
    const linked = await findLinkedAccounts({ id: 'u1' });
    expect(linked.map(({ id, blocked }) => ({ id, blocked }))).toEqual([
      { id: 'u2', blocked: true },
      { id: 'u3', blocked: false },
    ]);
  });

  it('reads nothing more when no account shares anything', async () => {
    mocks.findLinkedUserIds.mockResolvedValue({ byCard: [], byNetwork: [] });
    await expect(findLinkedAccounts({ id: 'u1' })).resolves.toEqual([]);
    expect(mocks.findIdsBySignupIp).not.toHaveBeenCalled();
    expect(mocks.findLinkStatesByIds).not.toHaveBeenCalled();
  });
});

describe('propagateAccountRisk', () => {
  const input = { sourceUserId: 'u1', trigger: 'dispute', key: 'dispute:dp_1:linked' };

  it('locks unblocked card links, alerts once with the network links for review', async () => {
    mocks.findLinkStatesByIds.mockImplementation(async (ids: string[]) =>
      ids.map(id => state(id, id === 'u4' ? { isBanned: true } : {}))
    );

    const result = await propagateAccountRisk(input, logger);

    expect(result).toEqual({ locked: ['u2'], review: ['u3'] });
    expect(mocks.flagDisputePending).toHaveBeenCalledTimes(1);
    expect(mocks.flagDisputePending).toHaveBeenCalledWith(expect.objectContaining({ id: 'u2' }), expect.anything());
    expect(mocks.claimStep).toHaveBeenCalledWith('dispute:dp_1:linked', 'linkedAlert', 'u1');
    const [message] = mocks.postMessageToSlack.mock.calls[0];
    expect(message).toContain('Locked (same card)');
    expect(message).toContain('`u2`');
    expect(message).toContain('Review (shared network only, not locked)');
    expect(message).toContain('`u3`');
    expect(message).not.toContain('`u4`');
  });

  it('locks again on a redelivery but does not alert twice', async () => {
    mocks.claimStep.mockResolvedValue(false);
    await propagateAccountRisk(input, logger);
    expect(mocks.flagDisputePending).toHaveBeenCalled();
    expect(mocks.postMessageToSlack).not.toHaveBeenCalled();
  });

  it('does nothing when linked-account actions are off', async () => {
    mocks.settings = { paymentRiskLinkedAccountActions: 'false' };
    await expect(propagateAccountRisk(input, logger)).resolves.toEqual({ locked: [], review: [] });
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.flagDisputePending).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    mocks.linkKeysForUser.mockRejectedValue(new Error('db down'));
    await expect(propagateAccountRisk(input, logger)).resolves.toEqual({ locked: [], review: [] });
  });
});

describe('lockIfPaidWithBlockedCard', () => {
  const input = { userId: 'u1', paymentIntentId: 'pi_1', cardFingerprints: ['fp_1'] };

  beforeEach(() => {
    mocks.findById.mockResolvedValue({ id: 'u1', disputePending: false });
    mocks.findLinkedUserIds.mockResolvedValue({ byCard: ['u2'], byNetwork: [] });
  });

  it('locks the payer when another account on the card is blocked, alerting once per payment', async () => {
    mocks.findLinkStatesByIds.mockResolvedValue([state('u2', { disputePending: true })]);

    await expect(lockIfPaidWithBlockedCard(input, logger)).resolves.toBe(true);

    expect(mocks.findLinkedUserIds).toHaveBeenCalledWith({
      userId: 'u1',
      cardFingerprints: ['fp_1'],
      ipHashes: [],
      limit: 25,
    });
    expect(mocks.flagDisputePending).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), expect.anything());
    expect(mocks.claimStep).toHaveBeenCalledWith('card-link:pi_1', 'alert', 'u1');
    expect(mocks.postMessageToSlack).toHaveBeenCalledTimes(1);
  });

  it('leaves the payer alone when no account on the card is blocked', async () => {
    await expect(lockIfPaidWithBlockedCard(input, logger)).resolves.toBe(false);
    expect(mocks.flagDisputePending).not.toHaveBeenCalled();
  });

  it('does nothing when linked-account actions are off', async () => {
    mocks.settings = { paymentRiskLinkedAccountActions: 'false' };
    mocks.findLinkStatesByIds.mockResolvedValue([state('u2', { disputePending: true })]);
    await expect(lockIfPaidWithBlockedCard(input, logger)).resolves.toBe(false);
    expect(mocks.flagDisputePending).not.toHaveBeenCalled();
  });
});

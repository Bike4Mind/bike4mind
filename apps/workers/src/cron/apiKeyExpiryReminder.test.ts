import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findExpiring: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://x/%STAGE%' } }));
vi.mock('@bike4mind/server-utils/utils/mailer/queuedMailer', () => ({ queuedMailer: {} }));
vi.mock('@bike4mind/server-utils/auth/expiredApiKeyRefusal', () => ({
  apiKeyRenewalUrl: () => 'https://app.example.com/profile?tab=api-keys',
}));
vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  userRepository: {},
  userApiKeyRepository: {
    findExpiringExplicitScopeOnly: h.findExpiring,
    claimExpiryReminder: h.claim,
    releaseExpiryReminder: h.release,
  },
}));
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { notifyApiKeyExpiring: h.notify } }));

import { runApiKeyExpiryReminder } from './apiKeyExpiryReminder';

const now = new Date('2027-01-10T00:00:00Z');
const key = (id: string) => ({ id, userId: `u-${id}`, name: `key ${id}`, expiresAt: new Date('2027-01-14T00:00:00Z') });

describe('runApiKeyExpiryReminder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.claim.mockResolvedValue(true);
    h.release.mockResolvedValue(undefined);
    h.notify.mockResolvedValue(true);
  });

  it('asks only for keys expiring within seven days', async () => {
    h.findExpiring.mockResolvedValue([]);
    await runApiKeyExpiryReminder(now);
    expect(h.findExpiring).toHaveBeenCalledWith(now, new Date('2027-01-17T00:00:00Z'));
  });

  it('emails each claimed key with its name, expiry and renewal link', async () => {
    h.findExpiring.mockResolvedValue([key('a')]);
    await expect(runApiKeyExpiryReminder(now)).resolves.toEqual({ found: 1, reminded: 1, failed: 0 });
    expect(h.notify).toHaveBeenCalledWith(
      {
        holderUserId: 'u-a',
        keyName: 'key a',
        expiresAt: new Date('2027-01-14T00:00:00Z'),
        renewUrl: 'https://app.example.com/profile?tab=api-keys',
      },
      expect.anything()
    );
  });

  it('sends nothing for a key another run already claimed', async () => {
    h.findExpiring.mockResolvedValue([key('a')]);
    h.claim.mockResolvedValue(false);
    await expect(runApiKeyExpiryReminder(now)).resolves.toEqual({ found: 1, reminded: 0, failed: 0 });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one key fails', async () => {
    h.findExpiring.mockResolvedValue([key('a'), key('b')]);
    h.claim.mockRejectedValueOnce(new Error('db down'));
    await expect(runApiKeyExpiryReminder(now)).resolves.toEqual({ found: 2, reminded: 1, failed: 1 });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
  });

  it('releases the claim and counts the key failed when the email was not queued', async () => {
    h.findExpiring.mockResolvedValue([key('a')]);
    h.notify.mockResolvedValue(false);
    await expect(runApiKeyExpiryReminder(now)).resolves.toEqual({ found: 1, reminded: 0, failed: 1 });
    const claimedAt = h.claim.mock.calls[0][1];
    expect(h.release).toHaveBeenCalledWith('a', claimedAt);
  });

  it('releases the claim when notifying throws, and keeps sweeping', async () => {
    h.findExpiring.mockResolvedValue([key('a'), key('b')]);
    h.notify.mockRejectedValueOnce(new Error('boom'));
    await expect(runApiKeyExpiryReminder(now)).resolves.toEqual({ found: 2, reminded: 1, failed: 1 });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release.mock.calls[0][0]).toBe('a');
  });
});

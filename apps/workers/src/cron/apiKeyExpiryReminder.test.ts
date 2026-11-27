import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findExpiring: vi.fn(),
  claim: vi.fn(),
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
  userApiKeyRepository: { findExpiringExplicitScopeOnly: h.findExpiring, claimExpiryReminder: h.claim },
}));
vi.mock('@bike4mind/services', () => ({ userApiKeyService: { notifyApiKeyExpiring: h.notify } }));

import { runApiKeyExpiryReminder, API_KEY_EXPIRY_REMINDER_WINDOW_MS } from './apiKeyExpiryReminder';

const now = new Date('2027-01-10T00:00:00Z');
const key = (id: string) => ({ id, userId: `u-${id}`, name: `key ${id}`, expiresAt: new Date('2027-01-14T00:00:00Z') });

describe('runApiKeyExpiryReminder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.claim.mockResolvedValue(true);
    h.notify.mockResolvedValue(undefined);
  });

  it('asks only for keys expiring within seven days', async () => {
    h.findExpiring.mockResolvedValue([]);
    await runApiKeyExpiryReminder(now);
    expect(h.findExpiring).toHaveBeenCalledWith(now, new Date(now.getTime() + API_KEY_EXPIRY_REMINDER_WINDOW_MS));
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
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  notifyApiKeyReowned: vi.fn(),
  users: { kind: 'users' as const },
}));
vi.mock('@bike4mind/services', () => ({
  userApiKeyService: { notifyApiKeyReowned: h.notifyApiKeyReowned },
}));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: h.users }));
vi.mock('./mailer', () => ({ default: { kind: 'mailer' } }));

import { notifyApiKeyRotationReown } from './apiKeyRotationNotifier';

describe('notifyApiKeyRotationReown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.notifyApiKeyReowned.mockResolvedValue(undefined);
  });

  it('calls notifyApiKeyReowned with the correct context', async () => {
    await notifyApiKeyRotationReown('prev-owner', 'My Key');
    expect(h.notifyApiKeyReowned).toHaveBeenCalledWith(
      { previousOwnerUserId: 'prev-owner', keyName: 'My Key' },
      expect.anything()
    );
  });

  it('threads userRepository as db.users into notifyApiKeyReowned', async () => {
    await notifyApiKeyRotationReown('prev-owner', 'My Key');
    const [, deps] = h.notifyApiKeyReowned.mock.calls[0];
    expect(deps.db.users).toBe(h.users);
  });

  it('threads the mailer singleton into notifyApiKeyReowned', async () => {
    await notifyApiKeyRotationReown('prev-owner', 'My Key');
    const [, deps] = h.notifyApiKeyReowned.mock.calls[0];
    expect(deps.mailer).toEqual({ kind: 'mailer' });
  });

  it('forwards an optional logger into notifyApiKeyReowned', async () => {
    const logger = { warn: vi.fn() };
    await notifyApiKeyRotationReown('prev-owner', 'My Key', logger);
    const [, deps] = h.notifyApiKeyReowned.mock.calls[0];
    expect(deps.logger).toBe(logger);
  });
});

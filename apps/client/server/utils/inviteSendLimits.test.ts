import { describe, it, expect, vi, beforeEach } from 'vitest';

const tryAddWithinLimitFixedWindow = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryAddWithinLimitFixedWindow },
  User: {},
}));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({ sendInviteNotificationEmails: vi.fn() }));

import { chargeTypedAddressBudget } from './inviteSendLimits';

describe('chargeTypedAddressBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryAddWithinLimitFixedWindow.mockResolvedValue({ success: true, count: 1, expiresAt: new Date() });
  });

  it('charges every typed address in a single call', async () => {
    await chargeTypedAddressBudget('u1', ['a@example.com', '507f1f77bcf86cd799439034', 'b@example.com']);

    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledOnce();
    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(
      'rate-limit:u1:project-invite-typed-address',
      2,
      20,
      60 * 60 * 1000
    );
  });

  it('skips the cache when no recipient is a typed address', async () => {
    await chargeTypedAddressBudget('u1', ['507f1f77bcf86cd799439034']);
    await chargeTypedAddressBudget('u1', undefined);

    expect(tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('refuses the request when the addresses do not fit in the remaining budget', async () => {
    tryAddWithinLimitFixedWindow.mockResolvedValue({ success: false, count: 19, expiresAt: new Date() });

    await expect(chargeTypedAddressBudget('u1', ['a@example.com', 'b@example.com'])).rejects.toThrow(
      /Too many email invitations/
    );
  });
});

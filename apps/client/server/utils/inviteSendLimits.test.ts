import { describe, it, expect, vi, beforeEach } from 'vitest';

const tryAddWithinLimitFixedWindow = vi.hoisted(() => vi.fn());
const decrementCounter = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryAddWithinLimitFixedWindow, decrementCounter },
  User: {},
}));
vi.mock('@server/utils/mailer/inviteNotificationEmail', () => ({ sendInviteNotificationEmails: vi.fn() }));

import { reserveInviteSendBudget } from './inviteSendLimits';

const HOUR_MS = 60 * 60 * 1000;
const RECIPIENT_KEY = 'rate-limit:u1:invite-recipients';
const TYPED_KEY = 'rate-limit:u1:project-invite-typed-address';
const MIXED_RECIPIENTS = ['a@example.com', '507f1f77bcf86cd799439034', 'b@example.com'];

const inWindow = () => ({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });

describe('reserveInviteSendBudget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tryAddWithinLimitFixedWindow.mockResolvedValue(inWindow());
  });

  it('charges every recipient, and every typed address when asked, each in a single call', async () => {
    await reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: true });

    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledTimes(2);
    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(RECIPIENT_KEY, 3, 200, HOUR_MS);
    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(TYPED_KEY, 2, 20, HOUR_MS);
  });

  it('leaves the typed-address budget alone when not asked', async () => {
    await reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: false });

    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledOnce();
    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledWith(RECIPIENT_KEY, 3, 200, HOUR_MS);
  });

  it('skips the cache for a request with no recipients', async () => {
    await reserveInviteSendBudget('u1', undefined, { chargeTypedAddresses: true });
    await reserveInviteSendBudget('u1', [], { chargeTypedAddresses: true });

    expect(tryAddWithinLimitFixedWindow).not.toHaveBeenCalled();
  });

  it('refuses the request when the recipients do not fit', async () => {
    tryAddWithinLimitFixedWindow.mockResolvedValueOnce({ success: false, count: 199, expiresAt: new Date() });

    await expect(reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: true })).rejects.toThrow(
      /Too many invitations/
    );
    expect(tryAddWithinLimitFixedWindow).toHaveBeenCalledOnce();
  });

  it('gives the recipient charge back when the typed addresses do not fit', async () => {
    tryAddWithinLimitFixedWindow
      .mockResolvedValueOnce(inWindow())
      .mockResolvedValueOnce({ success: false, count: 19, expiresAt: new Date() });

    await expect(reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: true })).rejects.toThrow(
      /Too many email invitations/
    );
    expect(decrementCounter).toHaveBeenCalledTimes(3);
    expect(decrementCounter).toHaveBeenCalledWith(RECIPIENT_KEY);
  });

  it('releases both charges once, however often release is called', async () => {
    const reservation = await reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: true });

    await reservation.release();
    await reservation.release();

    expect(decrementCounter.mock.calls.filter(([key]) => key === RECIPIENT_KEY)).toHaveLength(3);
    expect(decrementCounter.mock.calls.filter(([key]) => key === TYPED_KEY)).toHaveLength(2);
  });

  it('does not release into a window that has already reset', async () => {
    tryAddWithinLimitFixedWindow.mockResolvedValue({ success: true, count: 3, expiresAt: new Date(Date.now() - 1) });
    const reservation = await reserveInviteSendBudget('u1', MIXED_RECIPIENTS, { chargeTypedAddresses: true });

    await reservation.release();

    expect(decrementCounter).not.toHaveBeenCalled();
  });
});

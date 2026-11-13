import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_BULK_ITEMS } from '@bike4mind/common';

const tryAddWithinLimitFixedWindow = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ cacheRepository: { tryAddWithinLimitFixedWindow } }));

import { reserveInviteAccept } from './inviteAcceptLimits';

describe('reserveInviteAccept', () => {
  beforeEach(() => tryAddWithinLimitFixedWindow.mockReset());

  it('charges one attempt to a per-user hourly window that fits a full bulk accept', async () => {
    tryAddWithinLimitFixedWindow.mockResolvedValue({ success: true, expiresAt: new Date() });
    await reserveInviteAccept('u1');
    const [key, amount, limit, windowMs] = tryAddWithinLimitFixedWindow.mock.calls[0];
    expect(key).toBe('rate-limit:u1:invite-accepts');
    expect(amount).toBe(1);
    expect(limit).toBeGreaterThanOrEqual(MAX_BULK_ITEMS);
    expect(windowMs).toBe(60 * 60 * 1000);
  });

  it('throws 429 once the window is spent', async () => {
    tryAddWithinLimitFixedWindow.mockResolvedValue({ success: false, expiresAt: new Date() });
    await expect(reserveInviteAccept('u1')).rejects.toMatchObject({ statusCode: 429 });
  });
});

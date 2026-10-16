import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindBySid = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ authSessionRepository: { findBySid: mockFindBySid } }));
vi.mock('@bike4mind/database/social', () => ({ REALTIME_CONNECTION_MAX_LIFETIME_MS: 2 * 60 * 60 * 1000 }));
vi.mock('@server/utils/errors', () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { UnauthorizedError } from '@server/utils/errors';
import { assertRealtimeSessionActive, gatewayCapExpiry } from './realtimeSession';

const HOUR_MS = 60 * 60 * 1000;

describe('assertRealtimeSessionActive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves for an active session', async () => {
    mockFindBySid.mockResolvedValue({ sid: 's1', expiresAt: new Date(Date.now() + HOUR_MS) });

    await expect(assertRealtimeSessionActive('s1')).resolves.toBeUndefined();
    expect(mockFindBySid).toHaveBeenCalledWith('s1');
  });

  it('refuses a revoked session', async () => {
    mockFindBySid.mockResolvedValue({ sid: 's1', revokedAt: new Date(), expiresAt: new Date(Date.now() + HOUR_MS) });

    await expect(assertRealtimeSessionActive('s1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses an expired session', async () => {
    mockFindBySid.mockResolvedValue({ sid: 's1', expiresAt: new Date(Date.now() - 1000) });

    await expect(assertRealtimeSessionActive('s1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses a session that does not exist', async () => {
    mockFindBySid.mockResolvedValue(null);

    await expect(assertRealtimeSessionActive('s1')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('resolves without a lookup for a sid-less (legacy) token', async () => {
    await expect(assertRealtimeSessionActive(undefined)).resolves.toBeUndefined();
    expect(mockFindBySid).not.toHaveBeenCalled();
  });
});

describe('gatewayCapExpiry', () => {
  it('is the gateway 2h cap after now', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');

    expect(gatewayCapExpiry(now)).toEqual(new Date('2026-10-14T14:00:00.000Z'));
  });
});

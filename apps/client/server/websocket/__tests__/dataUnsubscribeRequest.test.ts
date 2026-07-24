import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for the WS unsubscribe handler's rotation-grace wiring: this path
 * used to compute `isBefore(now + 1 day)` inline, which is true for any past rotation
 * and so trusted a retired JWT_SECRET indefinitely (see secretRotationGrace.ts). Now
 * it delegates to the shared helper - this pins that the helper's return value is what
 * decides whether `previousSecret` is passed to `verifyToken`.
 */

vi.mock('@bike4mind/common', () => ({
  DataUnsubscribeRequestAction: { parse: (x: unknown) => x },
}));

vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
}));

const mockFindByKeyName = vi.fn();
vi.mock('@bike4mind/database/infra', () => ({
  secretRotationRepository: { findByKeyName: (...args: unknown[]) => mockFindByKeyName(...args) },
}));

const mockIsWithinGraceWindow = vi.fn();
vi.mock('@server/auth/secretRotationGrace', () => ({
  isRotatedSecretWithinGraceWindow: (...args: unknown[]) => mockIsWithinGraceWindow(...args),
}));

const mockVerifyToken = vi.fn();
vi.mock('@server/auth/tokenGenerator', () => ({
  authTokenGenerator: { verifyToken: (...args: unknown[]) => mockVerifyToken(...args) },
}));

const mockFindById = vi.fn();
const mockUpdateOne = vi.fn();
vi.mock('@bike4mind/database', () => ({
  User: { findById: (...args: unknown[]) => mockFindById(...args) },
  QuerySubscription: { updateOne: (...args: unknown[]) => mockUpdateOne(...args) },
}));

vi.mock('@server/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      return new Proxy({}, { get: () => `mock-${String(key)}` });
    },
  }),
}));

import { func } from '../dataUnsubscribeRequest';

const baseEvent = (accessToken = 'token-123') => ({
  requestContext: { connectionId: 'conn-1' },
  body: JSON.stringify({ action: 'unsubscribe_query', accessToken, subscriptionId: 'sub-1' }),
});
const noopLogger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

describe('dataUnsubscribeRequest WS handler - rotation grace window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyToken.mockReturnValue({ id: 'user-1' });
    mockFindById.mockResolvedValue({ id: 'user-1' });
    mockUpdateOne.mockResolvedValue({ acknowledged: true });
  });

  it('passes the rotated previousKey when the helper reports the rotation is within window', async () => {
    mockFindByKeyName.mockResolvedValue({ rotatedAt: new Date(), previousKey: 'prev-secret' });
    mockIsWithinGraceWindow.mockReturnValue(true);

    await func(baseEvent() as any, {} as any, noopLogger as any);

    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', 'prev-secret');
  });

  it('omits the previous secret when the helper reports the rotation is outside the window', async () => {
    mockFindByKeyName.mockResolvedValue({ rotatedAt: new Date(0), previousKey: 'prev-secret' });
    mockIsWithinGraceWindow.mockReturnValue(false);

    await func(baseEvent() as any, {} as any, noopLogger as any);

    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', undefined);
  });

  it('omits the previous secret when there is no recorded rotation', async () => {
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);

    await func(baseEvent() as any, {} as any, noopLogger as any);

    expect(mockIsWithinGraceWindow).toHaveBeenCalledWith(undefined);
    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', undefined);
  });

  it('pulls the subscriber for the resolved connection once verified', async () => {
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);

    const result = await func(baseEvent() as any, {} as any, noopLogger as any);

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        'subscribers.connectionId': 'conn-1',
        'subscribers.clientId': 'sub-1',
      }),
      expect.objectContaining({ $pull: expect.any(Object) })
    );
    expect(result).toEqual({ statusCode: 200 });
  });

  it('throws NotFoundError when the decoded user does not exist', async () => {
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);
    mockFindById.mockResolvedValue(null);

    await expect(func(baseEvent() as any, {} as any, noopLogger as any)).rejects.toThrow();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
vi.mock('@bike4mind/database', () => ({
  User: { findById: (...args: unknown[]) => mockFindById(...args) },
}));

vi.mock('@server/utils/errors', () => ({
  NotFoundError: class NotFoundError extends Error {},
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import { verifyWsAccessToken } from './verifyWsAccessToken';

describe('verifyWsAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindByKeyName.mockResolvedValue(null);
    mockIsWithinGraceWindow.mockReturnValue(false);
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'access' });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 3 });
  });

  it('returns the user for a current access token', async () => {
    await expect(verifyWsAccessToken('token-123')).resolves.toEqual({ id: 'user-1', tokenVersion: 3 });
  });

  it('rejects a token whose tokenVersion is stale relative to the user', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 2, typ: 'access' });

    await expect(verifyWsAccessToken('token-123')).rejects.toThrow('Session expired');
  });

  it('rejects a refresh token presented as an access token', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1', tokenVersion: 3, typ: 'refresh' });

    await expect(verifyWsAccessToken('token-123')).rejects.toThrow('Invalid token type');
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('accepts a legacy token carrying no typ and no tokenVersion against a default-version user', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1' });
    mockFindById.mockResolvedValue({ id: 'user-1' });

    await expect(verifyWsAccessToken('token-123')).resolves.toEqual({ id: 'user-1' });
  });

  it('fires the kill switch on a legacy token once the user version is bumped', async () => {
    mockVerifyToken.mockReturnValue({ id: 'user-1' });
    mockFindById.mockResolvedValue({ id: 'user-1', tokenVersion: 1 });

    await expect(verifyWsAccessToken('token-123')).rejects.toThrow('Session expired');
  });

  it('throws when the decoded user no longer exists', async () => {
    mockFindById.mockResolvedValue(null);

    await expect(verifyWsAccessToken('token-123')).rejects.toThrow('User not found');
  });

  it('passes the rotated previousKey only within the grace window', async () => {
    mockFindByKeyName.mockResolvedValue({ rotatedAt: new Date(), previousKey: 'prev-secret' });
    mockIsWithinGraceWindow.mockReturnValue(true);

    await verifyWsAccessToken('token-123');

    expect(mockVerifyToken).toHaveBeenCalledWith('token-123', 'prev-secret');
  });
});

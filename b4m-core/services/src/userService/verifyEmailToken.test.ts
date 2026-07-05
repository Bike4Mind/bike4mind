import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyEmailToken, VerifyEmailTokenParameters } from './verifyEmailToken';
import { BadRequestError } from '@bike4mind/utils';

const baseParams: VerifyEmailTokenParameters = {
  token: 'valid-token-123',
};

describe('verifyEmailToken', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: 'userId123',
      email: 'test@example.com',
      username: 'testuser',
      emailVerified: false,
      emailVerificationToken: 'valid-token-123',
      emailVerificationSentAt: new Date(Date.now() - 60000),
      emailVerificationExpires: new Date(Date.now() + 60000), // Valid for 1 more minute
      emailVerifiedAt: null,
    };
    mockAdapters = {
      db: {
        users: {
          findByEmailVerificationToken: vi.fn().mockResolvedValue(mockUser),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should verify email and update user with verified status', async () => {
    const before = Date.now();
    await verifyEmailToken(baseParams, mockAdapters);

    expect(mockAdapters.db.users.findByEmailVerificationToken).toHaveBeenCalledWith(baseParams.token);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        emailVerified: true,
        emailVerifiedAt: expect.any(Date),
        emailVerificationToken: null,
        emailVerificationSentAt: null,
        emailVerificationExpires: null,
      })
    );

    // Check that verifiedAt timestamp is recent
    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedUser.emailVerifiedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('should throw BadRequestError if token is not found', async () => {
    mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(null);
    await expect(verifyEmailToken(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailToken(baseParams, mockAdapters)).rejects.toThrow('Invalid or expired verification token');
  });

  it('should throw BadRequestError if token is expired', async () => {
    mockUser.emailVerificationExpires = new Date(Date.now() - 60000); // Expired 1 minute ago
    await expect(verifyEmailToken(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailToken(baseParams, mockAdapters)).rejects.toThrow(
      'Verification token has expired. Please request a new one.'
    );
  });

  it('should clear all verification fields after successful verification', async () => {
    await verifyEmailToken(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerificationToken).toBeNull();
    expect(updatedUser.emailVerificationSentAt).toBeNull();
    expect(updatedUser.emailVerificationExpires).toBeNull();
    expect(updatedUser.emailVerified).toBe(true);
    expect(updatedUser.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('should handle token on the exact expiry boundary (still valid)', async () => {
    // Since implementation uses `<`, a token expiring exactly now is still valid
    const now = Date.now();
    mockUser.emailVerificationExpires = new Date(now);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await expect(verifyEmailToken(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should accept token that expires in the future', async () => {
    mockUser.emailVerificationExpires = new Date(Date.now() + 86400000); // Expires in 24 hours
    await expect(verifyEmailToken(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
  });

  it('should work even if user is already verified (idempotent)', async () => {
    mockUser.emailVerified = true;
    mockUser.emailVerifiedAt = new Date(Date.now() - 3600000);

    await verifyEmailToken(baseParams, mockAdapters);

    // Should still update and set new verified date
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerified).toBe(true);
  });
});

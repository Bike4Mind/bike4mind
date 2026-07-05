import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyEmailChange, VerifyEmailChangeParameters } from './verifyEmailChange';
import { BadRequestError } from '@bike4mind/utils';

const baseParams: VerifyEmailChangeParameters = {
  token: 'valid-token-123',
};

describe('verifyEmailChange', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: 'userId123',
      email: 'oldemail@example.com',
      username: 'testuser',
      emailVerified: true,
      emailVerifiedAt: new Date(Date.now() - 86400000),
      pendingEmail: 'newemail@example.com',
      pendingEmailToken: 'valid-token-123',
      pendingEmailSentAt: new Date(Date.now() - 60000),
      pendingEmailExpires: new Date(Date.now() + 60000), // Valid for 1 more minute
    };
    mockAdapters = {
      db: {
        users: {
          findByPendingEmailToken: vi.fn().mockResolvedValue(mockUser),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should verify email change and update user email', async () => {
    const before = Date.now();
    await verifyEmailChange(baseParams, mockAdapters);

    expect(mockAdapters.db.users.findByPendingEmailToken).toHaveBeenCalledWith(baseParams.token);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'newemail@example.com',
        pendingEmail: null,
        pendingEmailToken: null,
        pendingEmailSentAt: null,
        pendingEmailExpires: null,
        emailVerified: true,
        emailVerifiedAt: expect.any(Date),
      })
    );

    // Check that verifiedAt timestamp is recent
    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedUser.emailVerifiedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('should throw BadRequestError if token is not found', async () => {
    mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(null);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow('Invalid or expired email change token');
  });

  it('should throw BadRequestError if user has no pendingEmailSentAt', async () => {
    mockUser.pendingEmailSentAt = null;
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow('Invalid or expired email change token');
  });

  it('should throw BadRequestError if user has no pendingEmail', async () => {
    mockUser.pendingEmail = null;
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow('Invalid or expired email change token');
  });

  it('should throw BadRequestError if token is expired', async () => {
    mockUser.pendingEmailExpires = new Date(Date.now() - 60000); // Expired 1 minute ago
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(
      'Email change token has expired. Please request a new email change.'
    );
  });

  it('should clear all pending email fields after successful verification', async () => {
    await verifyEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.pendingEmailToken).toBeNull();
    expect(updatedUser.pendingEmailSentAt).toBeNull();
    expect(updatedUser.pendingEmailExpires).toBeNull();
    expect(updatedUser.pendingEmail).toBeNull();
    expect(updatedUser.email).toBe('newemail@example.com');
  });

  it('should handle token on the exact expiry boundary (still valid)', async () => {
    // Since implementation uses `<`, a token expiring exactly now is still valid
    const now = Date.now();
    mockUser.pendingEmailExpires = new Date(now);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    await expect(verifyEmailChange(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('should accept token that expires in the future', async () => {
    mockUser.pendingEmailExpires = new Date(Date.now() + 86400000); // Expires in 24 hours
    await expect(verifyEmailChange(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
  });

  it('should use default 24-hour expiry if pendingEmailExpires is not set', async () => {
    mockUser.pendingEmailExpires = null;
    mockUser.pendingEmailSentAt = new Date(Date.now() - 1000); // 1 second ago

    // Should not throw since within 24 hours
    await expect(verifyEmailChange(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
  });

  it('should fail with default expiry if more than 24 hours passed', async () => {
    mockUser.pendingEmailExpires = null;
    mockUser.pendingEmailSentAt = new Date(Date.now() - 86400001); // Just over 24 hours ago

    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(verifyEmailChange(baseParams, mockAdapters)).rejects.toThrow('Email change token has expired');
  });

  it('should mark email as verified with new timestamp', async () => {
    const before = Date.now();
    await verifyEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerified).toBe(true);
    expect(updatedUser.emailVerifiedAt).toBeInstanceOf(Date);
    expect(updatedUser.emailVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

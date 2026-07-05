import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resendEmailVerification, ResendEmailVerificationParameters } from './resendEmailVerification';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY } from './sendEmailVerification';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const baseParams: ResendEmailVerificationParameters = {
  userId: 'userId123',
};

describe('resendEmailVerification', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: baseParams.userId,
      email: 'test@example.com',
      username: 'testuser',
      emailVerified: false,
      emailVerificationToken: 'old-token-123',
      emailVerificationSentAt: new Date(Date.now() - 60000),
      emailVerificationExpires: new Date(Date.now() + 60000),
    };
    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue(mockUser),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
      mailer: {
        sendEmailVerificationEmail: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should resend verification email with new token', async () => {
    const before = Date.now();
    await resendEmailVerification(baseParams, mockAdapters);

    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        emailVerificationToken: expect.any(String),
        emailVerificationSentAt: expect.any(Date),
        emailVerificationExpires: expect.any(Date),
      })
    );
    expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: mockUser.email }),
      expect.any(String)
    );

    // Check expiry is about EMAIL_VERIFICATION_TOKEN_EXPIRY ms in the future
    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerificationExpires.getTime()).toBeGreaterThanOrEqual(
      before + EMAIL_VERIFICATION_TOKEN_EXPIRY
    );
    expect(updatedUser.emailVerificationExpires.getTime()).toBeLessThanOrEqual(
      before + EMAIL_VERIFICATION_TOKEN_EXPIRY + 1000
    ); // 1s leeway
  });

  it('should throw NotFoundError if user is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow('User not found');
  });

  it('should throw NotFoundError if user does not have an email address', async () => {
    mockUser.email = null;
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(
      'User does not have an email address'
    );
  });

  it('should throw BadRequestError if email is already verified', async () => {
    mockUser.emailVerified = true;
    mockUser.emailVerifiedAt = new Date();
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(resendEmailVerification(baseParams, mockAdapters)).rejects.toThrow('Email is already verified');
  });

  it('should generate a new token even if previous token was not expired', async () => {
    mockUser.emailVerificationToken = 'old-token-123';
    mockUser.emailVerificationExpires = new Date(Date.now() + 86400000); // Still valid for 24 hours

    await resendEmailVerification(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerificationToken).toBeTruthy();
    expect(updatedUser.emailVerificationToken).not.toBe('old-token-123');
  });

  it('should update sentAt timestamp on resend', async () => {
    const oldSentAt = new Date(Date.now() - 3600000); // 1 hour ago
    mockUser.emailVerificationSentAt = oldSentAt;

    const before = Date.now();
    await resendEmailVerification(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerificationSentAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedUser.emailVerificationSentAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(updatedUser.emailVerificationSentAt.getTime()).toBeGreaterThan(oldSentAt.getTime());
  });

  it('should work even if user never had a previous token', async () => {
    mockUser.emailVerificationToken = null;
    mockUser.emailVerificationSentAt = null;
    mockUser.emailVerificationExpires = null;

    await expect(resendEmailVerification(baseParams, mockAdapters)).resolves.not.toThrow();
    expect(mockAdapters.db.users.update).toHaveBeenCalled();
    expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalled();
  });
});

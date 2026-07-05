import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestEmailChange, RequestEmailChangeParameters } from './requestEmailChange';
import { EMAIL_VERIFICATION_TOKEN_EXPIRY } from './sendEmailVerification';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

const baseParams: RequestEmailChangeParameters = {
  userId: 'userId123',
  newEmail: 'newemail@example.com',
};

describe('requestEmailChange', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: baseParams.userId,
      email: 'oldemail@example.com',
      username: 'testuser',
      emailVerified: true,
      emailVerifiedAt: new Date(),
      pendingEmail: null,
      pendingEmailToken: null,
      pendingEmailSentAt: null,
      pendingEmailExpires: null,
    };
    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue(mockUser),
          findByEmail: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue(undefined),
        },
      },
      mailer: {
        sendEmailChangeVerification: vi.fn().mockResolvedValue(undefined),
        sendEmailChangeNotification: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should request email change with new token', async () => {
    const before = Date.now();
    await requestEmailChange(baseParams, mockAdapters);

    expect(mockAdapters.db.users.findById).toHaveBeenCalledWith(baseParams.userId);
    expect(mockAdapters.db.users.findByEmail).toHaveBeenCalledWith(baseParams.newEmail);
    expect(mockAdapters.db.users.update).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingEmail: baseParams.newEmail,
        pendingEmailToken: expect.any(String),
        pendingEmailSentAt: expect.any(Date),
        pendingEmailExpires: expect.any(Date),
      })
    );
    expect(mockAdapters.mailer.sendEmailChangeVerification).toHaveBeenCalledWith(
      expect.objectContaining({ email: mockUser.email }),
      baseParams.newEmail,
      expect.any(String)
    );

    // Check expiry is about EMAIL_VERIFICATION_TOKEN_EXPIRY ms in the future
    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.pendingEmailExpires.getTime()).toBeGreaterThanOrEqual(before + EMAIL_VERIFICATION_TOKEN_EXPIRY);
    expect(updatedUser.pendingEmailExpires.getTime()).toBeLessThanOrEqual(
      before + EMAIL_VERIFICATION_TOKEN_EXPIRY + 1000
    ); // 1s leeway
  });

  it('should throw NotFoundError if user is not found', async () => {
    mockAdapters.db.users.findById.mockResolvedValue(null);
    await expect(requestEmailChange(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
    await expect(requestEmailChange(baseParams, mockAdapters)).rejects.toThrow('User not found');
  });

  it('should throw BadRequestError if new email is same as current email', async () => {
    const sameEmailParams = { ...baseParams, newEmail: mockUser.email };
    await expect(requestEmailChange(sameEmailParams, mockAdapters)).rejects.toThrow(BadRequestError);
    await expect(requestEmailChange(sameEmailParams, mockAdapters)).rejects.toThrow(
      'New email must be different from current email'
    );
  });

  it('should be case-insensitive when checking if new email matches current email', async () => {
    const sameEmailParams = { ...baseParams, newEmail: mockUser.email.toUpperCase() };
    await expect(requestEmailChange(sameEmailParams, mockAdapters)).rejects.toThrow(BadRequestError);
  });

  it('should silently fail if new email is already taken by another user (prevent enumeration)', async () => {
    mockAdapters.db.users.findByEmail.mockResolvedValue({ id: 'differentUserId', email: baseParams.newEmail });

    // Should not throw error (silent fail to prevent email enumeration)
    await expect(requestEmailChange(baseParams, mockAdapters)).resolves.not.toThrow();

    // Should not update user or send emails
    expect(mockAdapters.db.users.update).not.toHaveBeenCalled();
    expect(mockAdapters.mailer.sendEmailChangeVerification).not.toHaveBeenCalled();
  });

  it('should allow email change if same user already has that email (edge case)', async () => {
    // Same user trying to set their current email again
    mockAdapters.db.users.findByEmail.mockResolvedValue(mockUser);
    const sameUserParams = { ...baseParams, newEmail: 'another@example.com' };

    // Should not throw
    await expect(requestEmailChange(sameUserParams, mockAdapters)).resolves.not.toThrow();
  });

  it('should generate a new token even if previous pending change exists', async () => {
    mockUser.pendingEmail = 'previouspending@example.com';
    mockUser.pendingEmailToken = 'old-token-123';
    mockUser.pendingEmailExpires = new Date(Date.now() + 86400000); // Still valid for 24 hours

    await requestEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.pendingEmailToken).toBeTruthy();
    expect(updatedUser.pendingEmailToken).not.toBe('old-token-123');
    expect(updatedUser.pendingEmail).toBe(baseParams.newEmail);
  });

  it('should update sentAt timestamp on new request', async () => {
    const oldSentAt = new Date(Date.now() - 3600000); // 1 hour ago
    mockUser.pendingEmailSentAt = oldSentAt;

    const before = Date.now();
    await requestEmailChange(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.pendingEmailSentAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(updatedUser.pendingEmailSentAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(updatedUser.pendingEmailSentAt.getTime()).toBeGreaterThan(oldSentAt.getTime());
  });

  it('should call mailer with correct user, new email and token', async () => {
    await requestEmailChange(baseParams, mockAdapters);

    expect(mockAdapters.mailer.sendEmailChangeVerification).toHaveBeenCalledTimes(1);
    expect(mockAdapters.mailer.sendEmailChangeVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockUser.id,
        email: mockUser.email,
        username: mockUser.username,
      }),
      baseParams.newEmail,
      expect.any(String)
    );
  });

  it('should send notification email to current email address before sending verification', async () => {
    await requestEmailChange(baseParams, mockAdapters);

    // Should send notification to old email
    expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledTimes(1);
    expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        email: mockUser.email,
      }),
      baseParams.newEmail
    );

    // Notification should be called before verification email
    expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledBefore(
      mockAdapters.mailer.sendEmailChangeVerification
    );
  });

  it('should not send notification email if silent fail due to email enumeration', async () => {
    mockAdapters.db.users.findByEmail.mockResolvedValue({ id: 'differentUserId', email: baseParams.newEmail });

    await requestEmailChange(baseParams, mockAdapters);

    // Should not send any emails
    expect(mockAdapters.mailer.sendEmailChangeNotification).not.toHaveBeenCalled();
    expect(mockAdapters.mailer.sendEmailChangeVerification).not.toHaveBeenCalled();
  });
});

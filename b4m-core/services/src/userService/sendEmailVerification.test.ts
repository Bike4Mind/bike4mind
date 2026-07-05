import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendEmailVerification,
  SendEmailVerificationParameters,
  EMAIL_VERIFICATION_TOKEN_EXPIRY,
} from './sendEmailVerification';
import { NotFoundError } from '@bike4mind/utils';

const baseParams: SendEmailVerificationParameters = {
  userId: 'userId123',
};

describe('sendEmailVerification', () => {
  let mockAdapters: any;
  let mockUser: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = {
      id: baseParams.userId,
      email: 'test@example.com',
      username: 'testuser',
      emailVerified: false,
      emailVerificationToken: undefined,
      emailVerificationSentAt: undefined,
      emailVerificationExpires: undefined,
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

  it('should send a verification email and update user with token and expiry', async () => {
    const before = Date.now();
    await sendEmailVerification(baseParams, mockAdapters);

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
    await expect(sendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
  });

  it('should throw NotFoundError if user does not have an email address', async () => {
    mockUser.email = null;
    await expect(sendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(NotFoundError);
    await expect(sendEmailVerification(baseParams, mockAdapters)).rejects.toThrow(
      'User does not have an email address'
    );
  });

  it('should generate a new token even if previous token exists', async () => {
    mockUser.emailVerificationToken = 'old-token-123';
    mockUser.emailVerificationSentAt = new Date(Date.now() - 60000);
    mockUser.emailVerificationExpires = new Date(Date.now() + 60000);

    await sendEmailVerification(baseParams, mockAdapters);

    const updatedUser = mockAdapters.db.users.update.mock.calls[0][0];
    expect(updatedUser.emailVerificationToken).toBeTruthy();
    expect(updatedUser.emailVerificationToken).not.toBe('old-token-123');
  });

  it('should call mailer with correct user and token', async () => {
    await sendEmailVerification(baseParams, mockAdapters);

    expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledTimes(1);
    expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        id: mockUser.id,
        email: mockUser.email,
        username: mockUser.username,
      }),
      expect.any(String)
    );
  });
});

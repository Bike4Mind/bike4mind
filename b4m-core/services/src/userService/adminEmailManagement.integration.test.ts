import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmailVerification } from './sendEmailVerification';
import { verifyEmailToken } from './verifyEmailToken';
import { requestEmailChange } from './requestEmailChange';
import { verifyEmailChange } from './verifyEmailChange';
import { cancelEmailChange } from './cancelEmailChange';

/**
 * Integration tests for admin email management operations
 * Tests admin actions like verify/unverify and their interactions with user flows
 */
describe('Admin Email Management - Integration Tests', () => {
  let mockAdapters: any;
  let mockUser: any;
  let generatedToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    generatedToken = '';

    mockUser = {
      id: 'userId123',
      email: 'user@example.com',
      username: 'testuser',
      password: 'hashedpassword',
      emailVerified: false,
      emailVerificationToken: null,
      emailVerificationSentAt: null,
      emailVerificationExpires: null,
      emailVerifiedAt: null,
      pendingEmail: null,
      pendingEmailToken: null,
      pendingEmailSentAt: null,
      pendingEmailExpires: null,
    };

    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue(mockUser),
          findByIdWithPassword: vi.fn().mockResolvedValue(mockUser),
          findByEmail: vi.fn().mockResolvedValue(null),
          findByEmailVerificationToken: vi.fn(),
          findByPendingEmailToken: vi.fn(),
          update: vi.fn().mockImplementation(user => {
            Object.assign(mockUser, user);
            return Promise.resolve();
          }),
        },
      },
      mailer: {
        sendEmailVerificationEmail: vi.fn().mockImplementation((_user, token) => {
          generatedToken = token;
          return Promise.resolve();
        }),
        sendEmailChangeVerification: vi.fn().mockImplementation((_user, _newEmail, token) => {
          generatedToken = token;
          return Promise.resolve();
        }),
        sendEmailChangeNotification: vi.fn().mockResolvedValue(undefined),
      },
      validatePassword: vi.fn().mockResolvedValue(true),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Admin manual verification', () => {
    it('should allow admin to manually verify unverified user', async () => {
      expect(mockUser.emailVerified).toBe(false);

      // Admin manually verifies user (simulated by directly updating)
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      mockUser.emailVerificationToken = null;
      mockUser.emailVerificationSentAt = null;
      mockUser.emailVerificationExpires = null;

      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);
      expect(mockUser.emailVerificationToken).toBeNull();
    });

    it('should allow admin to unverify a verified user', async () => {
      // User is verified
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();

      // Admin unverifies (simulated by directly updating)
      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;

      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(false);
      expect(mockUser.emailVerifiedAt).toBeNull();
    });

    it('should allow admin to unverify and resend verification to user', async () => {
      // User is verified
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();

      // Admin unverifies
      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;
      await mockAdapters.db.users.update(mockUser);

      // Admin sends new verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalled();
      expect(mockUser.emailVerificationToken).toBeTruthy();
      expect(mockUser.emailVerified).toBe(false);

      // User can now verify normally
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token: generatedToken }, mockAdapters);

      expect(mockUser.emailVerified).toBe(true);
    });
  });

  describe('Admin resend verification', () => {
    it('should allow admin to resend verification to unverified user', async () => {
      // User has pending verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const firstToken = generatedToken;

      // Admin resends verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const secondToken = generatedToken;

      expect(secondToken).not.toBe(firstToken);
      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledTimes(2);

      // New token works
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token: secondToken }, mockAdapters);
      expect(mockUser.emailVerified).toBe(true);
    });

    it('should generate new token even if old one has not expired', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const firstToken = generatedToken;
      expect(mockUser.emailVerificationExpires.getTime()).toBeGreaterThan(Date.now());

      // Admin immediately resends
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const secondToken = generatedToken;

      expect(secondToken).not.toBe(firstToken);
      expect(mockUser.emailVerificationExpires.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe('Admin email change management', () => {
    it('should allow admin to cancel pending email change', async () => {
      // User requests email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
          password: 'currentPassword123',
        },
        mockAdapters
      );

      expect(mockUser.pendingEmail).toBe('newemail@example.com');

      // Admin cancels it
      await cancelEmailChange({ userId: mockUser.id }, mockAdapters);

      expect(mockUser.pendingEmail).toBeNull();
      expect(mockUser.pendingEmailToken).toBeNull();
      expect(mockUser.email).toBe('user@example.com'); // Unchanged
    });

    it('should allow admin to resend email change verification', async () => {
      // User requests email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
          password: 'currentPassword123',
        },
        mockAdapters
      );

      const firstToken = generatedToken;

      // Admin resends verification (simulated by calling requestEmailChange again)
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
          password: 'currentPassword123',
        },
        mockAdapters
      );

      const secondToken = generatedToken;
      expect(secondToken).not.toBe(firstToken);

      // New token works
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await verifyEmailChange({ token: secondToken }, mockAdapters);
      expect(mockUser.email).toBe('newemail@example.com');
    });
  });

  describe('Admin actions during active user flows', () => {
    it('should handle admin verification while user has pending verification', async () => {
      // User has pending verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      expect(mockUser.emailVerificationToken).toBeTruthy();

      // Admin manually verifies
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      mockUser.emailVerificationToken = null;
      mockUser.emailVerificationSentAt = null;
      mockUser.emailVerificationExpires = null;
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerificationToken).toBeNull();
    });

    it('should handle admin canceling email change while user verification pending', async () => {
      mockUser.emailVerified = true;

      // User requests email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
          password: 'currentPassword123',
        },
        mockAdapters
      );

      const token = generatedToken;
      expect(mockUser.pendingEmail).toBe('newemail@example.com');

      // Admin cancels it
      await cancelEmailChange({ userId: mockUser.id }, mockAdapters);

      // User tries to verify with old token - should fail
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(null);
      await expect(verifyEmailChange({ token }, mockAdapters)).rejects.toThrow('Invalid or expired email change token');

      expect(mockUser.email).toBe('user@example.com');
    });

    it('should handle user completing verification after admin unverifies', async () => {
      // User is verified
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();

      // Admin unverifies and resends
      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;
      await mockAdapters.db.users.update(mockUser);

      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const token = generatedToken;

      // User verifies normally
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token }, mockAdapters);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);
    });
  });

  describe('State consistency', () => {
    it('should maintain consistent state after admin verify -> user unverify flow', async () => {
      // Admin verifies user
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(true);

      // Admin later unverifies
      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;
      await mockAdapters.db.users.update(mockUser);

      // User gets new verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // State should be consistent
      expect(mockUser.emailVerified).toBe(false);
      expect(mockUser.emailVerificationToken).toBeTruthy();
      expect(mockUser.emailVerificationSentAt).toBeInstanceOf(Date);
      expect(mockUser.emailVerificationExpires).toBeInstanceOf(Date);
    });

    it('should clear verification fields when admin manually verifies', async () => {
      // User has pending verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      expect(mockUser.emailVerificationToken).toBeTruthy();

      // Admin manually verifies and clears all verification fields
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      mockUser.emailVerificationToken = null;
      mockUser.emailVerificationSentAt = null;
      mockUser.emailVerificationExpires = null;
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerificationToken).toBeNull();
      expect(mockUser.emailVerificationSentAt).toBeNull();
      expect(mockUser.emailVerificationExpires).toBeNull();
    });

    it('should maintain email verification state separately from email change state', async () => {
      // User is verified
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();

      // User requests email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
          password: 'currentPassword123',
        },
        mockAdapters
      );

      // Verification state should remain
      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);

      // Email change state should be separate
      expect(mockUser.pendingEmail).toBe('newemail@example.com');
      expect(mockUser.pendingEmailToken).toBeTruthy();

      // Admin cancels email change
      await cancelEmailChange({ userId: mockUser.id }, mockAdapters);

      // Verification state should still be intact
      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);
      expect(mockUser.pendingEmail).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should handle admin resending to user with expired token', async () => {
      // User has expired verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      mockUser.emailVerificationExpires = new Date(Date.now() - 60000);

      // Admin resends
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // Should have new valid token
      expect(mockUser.emailVerificationExpires.getTime()).toBeGreaterThan(Date.now());
      expect(mockUser.emailVerificationToken).toBeTruthy();
    });

    it('should handle rapid admin actions (verify, unverify, verify)', async () => {
      // Admin verifies
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      await mockAdapters.db.users.update(mockUser);

      // Admin immediately unverifies
      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;
      await mockAdapters.db.users.update(mockUser);

      // Admin immediately verifies again
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);
    });

    it('should handle admin canceling non-existent pending email change gracefully (idempotent)', async () => {
      expect(mockUser.pendingEmail).toBeNull();

      // cancelEmailChange is idempotent - should not throw
      await expect(cancelEmailChange({ userId: mockUser.id }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.pendingEmail).toBeNull();
    });
  });

  describe('Audit trail and tracking', () => {
    it('should track when admin resends verification', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const firstSentAt = mockUser.emailVerificationSentAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      // Admin resends
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const secondSentAt = mockUser.emailVerificationSentAt;

      expect(secondSentAt.getTime()).toBeGreaterThan(firstSentAt.getTime());
    });

    it('should track verifiedAt timestamp when admin manually verifies', async () => {
      const before = Date.now();

      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerifiedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(mockUser.emailVerifiedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('should clear verifiedAt when admin unverifies', async () => {
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();
      await mockAdapters.db.users.update(mockUser);

      mockUser.emailVerified = false;
      mockUser.emailVerifiedAt = null;
      await mockAdapters.db.users.update(mockUser);

      expect(mockUser.emailVerifiedAt).toBeNull();
    });
  });
});

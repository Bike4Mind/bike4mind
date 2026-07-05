import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendEmailVerification } from './sendEmailVerification';
import { resendEmailVerification } from './resendEmailVerification';
import { verifyEmailToken } from './verifyEmailToken';
import { BadRequestError } from '@bike4mind/utils';

/**
 * Integration tests for email verification flow
 * Tests the complete user journey from registration to email verification
 */
describe('Email Verification Flow - Integration Tests', () => {
  let mockAdapters: any;
  let mockUser: any;
  let generatedToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    generatedToken = '';

    mockUser = {
      id: 'userId123',
      email: 'newuser@example.com',
      username: 'newuser',
      emailVerified: false,
      emailVerificationToken: null,
      emailVerificationSentAt: null,
      emailVerificationExpires: null,
      emailVerifiedAt: null,
    };

    mockAdapters = {
      db: {
        users: {
          findById: vi.fn().mockResolvedValue(mockUser),
          findByIdWithPassword: vi.fn().mockResolvedValue(mockUser),
          findByEmailVerificationToken: vi.fn(),
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
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Complete successful flow', () => {
    it('should complete the full verification flow: send -> verify', async () => {
      // Step 1: User registers and verification email is sent
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledTimes(1);
      expect(generatedToken).toBeTruthy();
      expect(mockUser.emailVerificationToken).toBe(generatedToken);
      expect(mockUser.emailVerificationSentAt).toBeInstanceOf(Date);
      expect(mockUser.emailVerificationExpires).toBeInstanceOf(Date);

      // Step 2: User clicks verification link
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token: generatedToken }, mockAdapters);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerifiedAt).toBeInstanceOf(Date);
      expect(mockUser.emailVerificationToken).toBeNull();
      expect(mockUser.emailVerificationSentAt).toBeNull();
      expect(mockUser.emailVerificationExpires).toBeNull();
    });

    it('should allow resending verification email before verification', async () => {
      // Step 1: Initial verification email sent
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const firstToken = generatedToken;
      expect(firstToken).toBeTruthy();

      // Step 2: User requests resend
      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const secondToken = generatedToken;

      expect(secondToken).toBeTruthy();
      expect(secondToken).not.toBe(firstToken);
      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledTimes(2);

      // Step 3: User verifies with new token
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token: secondToken }, mockAdapters);

      expect(mockUser.emailVerified).toBe(true);
    });
  });

  describe('Token expiration handling', () => {
    it('should reject expired verification token', async () => {
      // Step 1: Send verification email
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // Step 2: Token expires (simulate by setting expiry to past)
      mockUser.emailVerificationExpires = new Date(Date.now() - 60000); // Expired 1 minute ago

      // Step 3: User tries to verify with expired token
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await expect(verifyEmailToken({ token: generatedToken }, mockAdapters)).rejects.toThrow(BadRequestError);
      await expect(verifyEmailToken({ token: generatedToken }, mockAdapters)).rejects.toThrow(
        'Verification token has expired. Please request a new one.'
      );

      // User should still be unverified
      expect(mockUser.emailVerified).toBe(false);
    });

    it('should allow resending after token expiration', async () => {
      // Step 1: Send verification email
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const expiredToken = generatedToken;

      // Step 2: Token expires
      mockUser.emailVerificationExpires = new Date(Date.now() - 60000);

      // Step 3: User requests resend, gets new valid token
      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const newToken = generatedToken;

      expect(newToken).not.toBe(expiredToken);
      expect(mockUser.emailVerificationExpires.getTime()).toBeGreaterThan(Date.now());

      // Step 4: Verify with new token succeeds
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await expect(verifyEmailToken({ token: newToken }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.emailVerified).toBe(true);
    });
  });

  describe('Security: Token validation', () => {
    it('should reject invalid token format', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(null);
      await expect(verifyEmailToken({ token: 'invalid-token-123' }, mockAdapters)).rejects.toThrow(BadRequestError);
      await expect(verifyEmailToken({ token: 'invalid-token-123' }, mockAdapters)).rejects.toThrow(
        'Invalid or expired verification token'
      );
    });

    it('should reject token with wrong length (timing attack protection)', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const realToken = generatedToken;

      // Try with token that's too short
      const shortToken = realToken.substring(0, realToken.length - 10);
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      mockUser.emailVerificationToken = realToken;

      await expect(verifyEmailToken({ token: shortToken }, mockAdapters)).rejects.toThrow(BadRequestError);
      expect(mockUser.emailVerified).toBe(false);
    });

    it('should reject empty token', async () => {
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(null);
      await expect(verifyEmailToken({ token: '' }, mockAdapters)).rejects.toThrow(BadRequestError);
    });
  });

  describe('Rate limiting and abuse prevention', () => {
    it('should allow multiple resend attempts (rate limit enforced at API level)', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // Simulate 3 rapid resend requests
      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);
      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);
      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);

      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalledTimes(4); // Initial + 3 resends
    });

    it('should track when verification was last sent', async () => {
      const before = Date.now();

      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      expect(mockUser.emailVerificationSentAt.getTime()).toBeGreaterThanOrEqual(before);

      // Wait a bit and resend
      await new Promise(resolve => setTimeout(resolve, 10));
      const middleTime = Date.now();

      await resendEmailVerification({ userId: mockUser.id }, mockAdapters);
      expect(mockUser.emailVerificationSentAt.getTime()).toBeGreaterThanOrEqual(middleTime);
    });
  });

  describe('Idempotency', () => {
    it('should prevent token reuse after verification', async () => {
      // Step 1: Complete normal verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);
      const token = generatedToken;
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await verifyEmailToken({ token }, mockAdapters);

      expect(mockUser.emailVerified).toBe(true);
      expect(mockUser.emailVerificationUsed).toBe(true);

      // Step 2: Try to verify again with same token - should fail (prevent reuse)
      mockUser.emailVerificationToken = token;
      mockUser.emailVerificationSentAt = new Date(); // Required field
      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);

      await expect(verifyEmailToken({ token }, mockAdapters)).rejects.toThrow(
        'Verification token has already been used'
      );
      expect(mockUser.emailVerified).toBe(true); // Still verified
    });

    it('should allow sending verification to already verified user (admin action)', async () => {
      mockUser.emailVerified = true;
      mockUser.emailVerifiedAt = new Date();

      // Admin unverifies and resends verification
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      expect(mockAdapters.mailer.sendEmailVerificationEmail).toHaveBeenCalled();
      expect(mockUser.emailVerificationToken).toBeTruthy();
    });
  });

  describe('Edge cases', () => {
    it('should handle user not found gracefully', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(null);

      await expect(sendEmailVerification({ userId: 'nonexistent' }, mockAdapters)).rejects.toThrow('User not found');
    });

    it('should handle missing emailVerificationSentAt field', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // Remove sentAt field
      mockUser.emailVerificationSentAt = null;

      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await expect(verifyEmailToken({ token: generatedToken }, mockAdapters)).rejects.toThrow(
        'Invalid or expired verification token'
      );
    });

    it('should handle email verification on exact expiry boundary', async () => {
      await sendEmailVerification({ userId: mockUser.id }, mockAdapters);

      // Set expiry to exactly now (should still be valid per implementation)
      const now = Date.now();
      mockUser.emailVerificationExpires = new Date(now);

      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockAdapters.db.users.findByEmailVerificationToken.mockResolvedValue(mockUser);
      await expect(verifyEmailToken({ token: generatedToken }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.emailVerified).toBe(true);

      vi.useRealTimers();
    });
  });
});

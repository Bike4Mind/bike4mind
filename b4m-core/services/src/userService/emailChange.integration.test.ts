import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestEmailChange } from './requestEmailChange';
import { verifyEmailChange } from './verifyEmailChange';
import { cancelEmailChange } from './cancelEmailChange';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';

/**
 * Integration tests for email change flow
 * Tests the complete user journey from requesting email change to verification/cancellation
 */
describe('Email Change Flow - Integration Tests', () => {
  let mockAdapters: any;
  let mockUser: any;
  let generatedToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    generatedToken = '';

    mockUser = {
      id: 'userId123',
      email: 'current@example.com',
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
          findByPendingEmailToken: vi.fn(),
          update: vi.fn().mockImplementation(user => {
            Object.assign(mockUser, user);
            return Promise.resolve();
          }),
        },
      },
      mailer: {
        sendEmailChangeVerification: vi.fn().mockImplementation((_user, _newEmail, token) => {
          generatedToken = token;
          return Promise.resolve();
        }),
        sendEmailChangeNotification: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Complete successful flow', () => {
    it('should complete the full email change flow: request -> verify', async () => {
      const newEmail = 'newemail@example.com';

      // Step 1: User requests email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledWith(mockUser, newEmail);
      expect(mockAdapters.mailer.sendEmailChangeVerification).toHaveBeenCalledTimes(1);
      expect(generatedToken).toBeTruthy();
      expect(mockUser.pendingEmail).toBe(newEmail);
      expect(mockUser.pendingEmailToken).toBe(generatedToken);
      expect(mockUser.pendingEmailSentAt).toBeInstanceOf(Date);
      expect(mockUser.pendingEmailExpires).toBeInstanceOf(Date);

      // Step 2: User clicks verification link in new email
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await verifyEmailChange({ token: generatedToken }, mockAdapters);

      expect(mockUser.email).toBe(newEmail);
      expect(mockUser.pendingEmail).toBeNull();
      expect(mockUser.pendingEmailToken).toBeNull();
      expect(mockUser.pendingEmailSentAt).toBeNull();
      expect(mockUser.pendingEmailExpires).toBeNull();
    });

    it('should send notification to old email before sending verification to new email', async () => {
      const newEmail = 'newemail@example.com';

      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      // Verify notification to old email is sent first
      expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledBefore(
        mockAdapters.mailer.sendEmailChangeVerification
      );
      expect(mockAdapters.mailer.sendEmailChangeNotification).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'current@example.com' }),
        newEmail
      );
    });
  });

  describe('Cancellation flow', () => {
    it('should allow user to cancel pending email change', async () => {
      const newEmail = 'newemail@example.com';

      // Step 1: Request email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      expect(mockUser.pendingEmail).toBe(newEmail);

      // Step 2: User cancels the change
      await cancelEmailChange({ userId: mockUser.id }, mockAdapters);

      expect(mockUser.email).toBe('current@example.com'); // Unchanged
      expect(mockUser.pendingEmail).toBeNull();
      expect(mockUser.pendingEmailToken).toBeNull();
      expect(mockUser.pendingEmailSentAt).toBeNull();
      expect(mockUser.pendingEmailExpires).toBeNull();
    });

    it('should work even if no pending email change to cancel (idempotent)', async () => {
      // cancelEmailChange is idempotent - it clears fields regardless
      await expect(cancelEmailChange({ userId: mockUser.id }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.pendingEmail).toBeNull();
    });

    it('should allow canceling even if token expired', async () => {
      const newEmail = 'newemail@example.com';

      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      // Token expires
      mockUser.pendingEmailExpires = new Date(Date.now() - 60000);

      // Cancellation should still work
      await expect(cancelEmailChange({ userId: mockUser.id }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.pendingEmail).toBeNull();
    });
  });

  describe('Token expiration handling', () => {
    it('should reject expired email change token', async () => {
      const newEmail = 'newemail@example.com';

      // Step 1: Request email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      // Step 2: Token expires
      mockUser.pendingEmailExpires = new Date(Date.now() - 60000);

      // Step 3: User tries to verify with expired token
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await expect(verifyEmailChange({ token: generatedToken }, mockAdapters)).rejects.toThrow(BadRequestError);
      await expect(verifyEmailChange({ token: generatedToken }, mockAdapters)).rejects.toThrow(
        'Email change token has expired. Please request a new email change.'
      );

      expect(mockUser.email).toBe('current@example.com'); // Unchanged
    });

    it('should allow requesting new email change after expiration', async () => {
      const newEmail = 'newemail@example.com';

      // Step 1: Request email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      const firstToken = generatedToken;

      // Step 2: Token expires
      mockUser.pendingEmailExpires = new Date(Date.now() - 60000);

      // Step 3: Request new email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail,
        },
        mockAdapters
      );

      const secondToken = generatedToken;
      expect(secondToken).not.toBe(firstToken);
      expect(mockUser.pendingEmailExpires.getTime()).toBeGreaterThan(Date.now());

      // Step 4: Verify with new token succeeds
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await expect(verifyEmailChange({ token: secondToken }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.email).toBe(newEmail);
    });
  });

  describe('Security: Email enumeration prevention', () => {
    it('should silently fail when new email is already taken (prevent enumeration)', async () => {
      const takenEmail = 'taken@example.com';
      mockAdapters.db.users.findByEmail.mockResolvedValue({
        id: 'differentUserId',
        email: takenEmail,
      });

      // Should not throw error (silent fail)
      await expect(
        requestEmailChange(
          {
            userId: mockUser.id,
            newEmail: takenEmail,
          },
          mockAdapters
        )
      ).resolves.not.toThrow();

      // But should not actually update user or send emails
      expect(mockUser.pendingEmail).toBeNull();
      expect(mockAdapters.mailer.sendEmailChangeNotification).not.toHaveBeenCalled();
      expect(mockAdapters.mailer.sendEmailChangeVerification).not.toHaveBeenCalled();
    });

    it('should allow email change if same user already has that email (edge case)', async () => {
      mockAdapters.db.users.findByEmail.mockResolvedValue(mockUser);

      await expect(
        requestEmailChange(
          {
            userId: mockUser.id,
            newEmail: 'another@example.com',
          },
          mockAdapters
        )
      ).resolves.not.toThrow();

      expect(mockUser.pendingEmail).toBe('another@example.com');
    });
  });

  describe('Security: Token validation', () => {
    it('should reject invalid token format', async () => {
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(null);

      await expect(verifyEmailChange({ token: 'invalid-token-123' }, mockAdapters)).rejects.toThrow(BadRequestError);
      await expect(verifyEmailChange({ token: 'invalid-token-123' }, mockAdapters)).rejects.toThrow(
        'Invalid or expired email change token'
      );
    });

    it('should reject token with wrong length (timing attack protection)', async () => {
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
        },
        mockAdapters
      );

      const realToken = generatedToken;
      const shortToken = realToken.substring(0, realToken.length - 10);

      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      mockUser.pendingEmailToken = realToken;

      await expect(verifyEmailChange({ token: shortToken }, mockAdapters)).rejects.toThrow(BadRequestError);
      expect(mockUser.email).toBe('current@example.com'); // Unchanged
    });

    it('should reject empty token', async () => {
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(null);
      await expect(verifyEmailChange({ token: '' }, mockAdapters)).rejects.toThrow(BadRequestError);
    });
  });

  describe('Validation', () => {
    it('should reject email change to same email', async () => {
      await expect(
        requestEmailChange(
          {
            userId: mockUser.id,
            newEmail: mockUser.email,
          },
          mockAdapters
        )
      ).rejects.toThrow('New email must be different from current email');
    });

    it('should be case-insensitive when checking if new email matches current', async () => {
      await expect(
        requestEmailChange(
          {
            userId: mockUser.id,
            newEmail: mockUser.email.toUpperCase(),
          },
          mockAdapters
        )
      ).rejects.toThrow('New email must be different from current email');
    });

    it('should reject if user not found', async () => {
      mockAdapters.db.users.findById.mockResolvedValue(null);

      await expect(
        requestEmailChange(
          {
            userId: 'nonexistent',
            newEmail: 'newemail@example.com',
          },
          mockAdapters
        )
      ).rejects.toThrow(NotFoundError);
    });

    it('should handle missing pendingEmailSentAt field during verification', async () => {
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
        },
        mockAdapters
      );

      mockUser.pendingEmailSentAt = null;

      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await expect(verifyEmailChange({ token: generatedToken }, mockAdapters)).rejects.toThrow(
        'Invalid or expired email change token'
      );
    });
  });

  describe('Multiple change requests', () => {
    it('should replace pending email when requesting another change', async () => {
      // Step 1: Request first email change
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'first@example.com',
        },
        mockAdapters
      );

      expect(mockUser.pendingEmail).toBe('first@example.com');
      const firstToken = generatedToken;

      // Step 2: Request second email change (before verifying first)
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'second@example.com',
        },
        mockAdapters
      );

      expect(mockUser.pendingEmail).toBe('second@example.com');
      const secondToken = generatedToken;
      expect(secondToken).not.toBe(firstToken);

      // Step 3: Old token should not work
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(null);
      await expect(verifyEmailChange({ token: firstToken }, mockAdapters)).rejects.toThrow(BadRequestError);

      // Step 4: New token should work
      mockUser.pendingEmailToken = secondToken;
      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await expect(verifyEmailChange({ token: secondToken }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.email).toBe('second@example.com');
    });
  });

  describe('Edge cases', () => {
    it('should handle email verification on exact expiry boundary', async () => {
      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
        },
        mockAdapters
      );

      const now = Date.now();
      mockUser.pendingEmailExpires = new Date(now);

      vi.useFakeTimers();
      vi.setSystemTime(now);

      mockAdapters.db.users.findByPendingEmailToken.mockResolvedValue(mockUser);
      await expect(verifyEmailChange({ token: generatedToken }, mockAdapters)).resolves.not.toThrow();
      expect(mockUser.email).toBe('newemail@example.com');

      vi.useRealTimers();
    });

    it('should track when email change was last requested', async () => {
      const before = Date.now();

      await requestEmailChange(
        {
          userId: mockUser.id,
          newEmail: 'newemail@example.com',
        },
        mockAdapters
      );

      expect(mockUser.pendingEmailSentAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(mockUser.pendingEmailSentAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });
});

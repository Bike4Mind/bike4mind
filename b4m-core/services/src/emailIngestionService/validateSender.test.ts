import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSenderAuthorization, extractEmails } from './validateSender';
import { IUserRepository } from '@bike4mind/common';
import type { ParsedEmailObject } from './types';

describe('emailIngestionService - validateSender', () => {
  describe('extractEmails', () => {
    it('should extract single email from EmailAddress object', () => {
      const emailObj = {
        value: [{ address: 'user@example.com', name: '' }],
        text: 'user@example.com',
      };
      const result = extractEmails(emailObj as any);
      expect(result).toEqual(['user@example.com']);
    });

    it('should extract email from EmailAddress with name', () => {
      const emailObj = {
        value: [{ address: 'john@example.com', name: 'John Doe' }],
        text: 'John Doe <john@example.com>',
      };
      const result = extractEmails(emailObj as any);
      expect(result).toEqual(['john@example.com']);
    });

    it('should extract multiple emails from array of EmailAddress', () => {
      const emailArray = [
        {
          value: [{ address: 'user1@example.com', name: '' }],
          text: 'user1@example.com',
        },
        {
          value: [{ address: 'user2@example.com', name: '' }],
          text: 'user2@example.com',
        },
      ];
      const result = extractEmails(emailArray as any);
      expect(result).toEqual(['user1@example.com', 'user2@example.com']);
    });

    it('should return empty array for undefined', () => {
      const result = extractEmails(undefined);
      expect(result).toEqual([]);
    });

    it('should lowercase all email addresses', () => {
      const emailObj = {
        value: [{ address: 'User@Example.COM', name: '' }],
        text: 'User@Example.COM',
      };
      const result = extractEmails(emailObj as any);
      expect(result).toEqual(['user@example.com']);
    });

    it('should handle EmailAddress with multiple values', () => {
      const emailObj = {
        value: [
          { address: 'user1@example.com', name: '' },
          { address: 'user2@example.com', name: '' },
        ],
        text: 'user1@example.com, user2@example.com',
      };
      const result = extractEmails(emailObj as any);
      expect(result).toEqual(['user1@example.com', 'user2@example.com']);
    });
  });

  describe('validateSenderAuthorization', () => {
    let mockUserRepository: IUserRepository;
    let mockParsedEmail: ParsedEmailObject;

    beforeEach(() => {
      vi.resetAllMocks();

      // Tests that omit an explicit platformDomain rely on the configured default, which now
      // reads PLATFORM_EMAIL_DOMAIN (no brand fallback). Seed it to the fixture domain;
      // restored in afterEach so the mutation can't leak across files if isolation is relaxed.
      process.env.PLATFORM_EMAIL_DOMAIN = '@app.example.com';

      mockUserRepository = {
        findOne: vi.fn(),
        find: vi.fn(),
        create: vi.fn(),
        findById: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        delete: vi.fn(),
        count: vi.fn(),
      };

      mockParsedEmail = {
        messageId: '<msg123@example.com>',
        from: {
          value: [{ address: 'sender@external.com', name: '' }],
          text: 'sender@external.com',
        } as any,
        to: {
          value: [{ address: 'user.platform@app.example.com', name: '' }],
          text: 'user.platform@app.example.com',
        } as any,
        subject: 'Test Email',
        date: new Date(),
        text: 'Test body',
      };
    });

    afterEach(() => {
      // Restore the env mutated in beforeEach so it can't leak to other test files.
      delete process.env.PLATFORM_EMAIL_DOMAIN;
    });

    it('should return null if no platform email found in To field', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'random@example.com', name: '' }], text: 'random@example.com' } as any,
      };
      const result = await validateSenderAuthorization(email, mockUserRepository, '@app.example.com');
      expect(result).toBeNull();
    });

    it('should return null if platform email format is invalid', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'invalid@app.example.com', name: '' }], text: 'invalid@app.example.com' } as any,
      };
      const result = await validateSenderAuthorization(email, mockUserRepository, '@app.example.com');
      expect(result).toBeNull();
    });

    it('returns null when no platform domain is configured — no match-all (security guard #9310)', async () => {
      // Open-core deployments may leave PLATFORM_EMAIL_DOMAIN unset. With no domain, the
      // extractor must NOT treat an arbitrary recipient as a platform address (an empty suffix
      // would make endsWith('') universal). It must return null and never reach the DB lookup.
      delete process.env.PLATFORM_EMAIL_DOMAIN;
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'anyone@example.com', name: '' }], text: 'anyone@example.com' } as any,
      };
      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toBeNull();
      expect(mockUserRepository.findOne).not.toHaveBeenCalled();
    });

    it('should extract platform email from To field with default domain', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'sender@external.com',
      });
    });

    it('should extract platform email with custom domain', async () => {
      const email = {
        ...mockParsedEmail,
        to: {
          value: [{ address: 'jane.smith@custom.domain.com', name: '' }],
          text: 'jane.smith@custom.domain.com',
        } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user456',
        email: 'jane@example.com',
        platformEmailAddress: 'jane.smith@custom.domain.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository, '@custom.domain.com');
      expect(result).toEqual({
        userId: 'user456',
        platformEmail: 'jane.smith@custom.domain.com',
        senderEmail: 'sender@external.com',
      });
    });

    it('should return null if user not found by platform email', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue(null);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toBeNull();
    });

    it('should return null if sender not in authorized list', async () => {
      const email = {
        ...mockParsedEmail,
        from: { value: [{ address: 'unauthorized@example.com', name: '' }], text: 'unauthorized@example.com' } as any,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['other@example.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toBeNull();
    });

    it('should validate sender from authorizedSenders array', async () => {
      const email = {
        ...mockParsedEmail,
        from: { value: [{ address: 'allowed@example.com', name: '' }], text: 'allowed@example.com' } as any,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['allowed@example.com', 'another@example.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: expect.any(String),
      });
    });

    it('should validate sender matching user email', async () => {
      const email = {
        ...mockParsedEmail,
        from: { value: [{ address: 'john@example.com', name: '' }], text: 'john@example.com' } as any,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['john@example.com'], // User's own email is authorized
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'john@example.com',
      });
    });

    it('should handle To field as array', async () => {
      const email = {
        ...mockParsedEmail,
        to: [
          { value: [{ address: 'other@example.com', name: '' }], text: 'other@example.com' } as any,
          { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
        ],
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: expect.any(String),
      });
    });

    it('should handle from field with name format', async () => {
      const email = {
        ...mockParsedEmail,
        from: {
          value: [{ address: 'sender@external.com', name: 'Sender Name' }],
          text: 'Sender Name <sender@external.com>',
        } as any,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: expect.any(String),
      });
    });

    it('should extract platform email from CC field', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'someone@example.com', name: '' }], text: 'someone@example.com' } as any,
        cc: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'sender@external.com',
      });
    });

    it('should extract platform email from BCC field', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'someone@example.com', name: '' }], text: 'someone@example.com' } as any,
        cc: undefined,
        bcc: {
          value: [{ address: 'john.doe@app.example.com', name: '' }],
          text: 'john.doe@app.example.com',
        } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'sender@external.com',
      });
    });

    it('should extract platform email from CC field when To field has non-platform emails', async () => {
      const email = {
        ...mockParsedEmail,
        to: [
          { value: [{ address: 'other1@example.com', name: '' }], text: 'other1@example.com' } as any,
          { value: [{ address: 'other2@example.com', name: '' }], text: 'other2@example.com' } as any,
        ],
        cc: [
          { value: [{ address: 'other3@example.com', name: '' }], text: 'other3@example.com' } as any,
          { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
        ],
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'sender@external.com',
      });
    });

    it('should prioritize To field over CC/BCC when platform email is in multiple fields', async () => {
      const email = {
        ...mockParsedEmail,
        to: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
        cc: { value: [{ address: 'john.doe@app.example.com', name: '' }], text: 'john.doe@app.example.com' } as any,
      };
      vi.mocked(mockUserRepository.findOne).mockResolvedValue({
        id: 'user123',
        email: 'john@example.com',
        platformEmailAddress: 'john.doe@app.example.com',
        authorizedEmailAddresses: ['sender@external.com'],
      } as any);

      const result = await validateSenderAuthorization(email, mockUserRepository);
      expect(result).toEqual({
        userId: 'user123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'sender@external.com',
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processIngestedEmail } from './processIngestedEmail';
import { UnauthorizedError } from '@bike4mind/utils';
import type { ParsedEmailObject, EmailIngestionAdapters } from './types';

vi.mock('./validateSender', () => ({
  validateSenderAuthorization: vi.fn(),
  extractEmails: vi.fn(input => {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    return input.split(',').map((e: string) => e.trim());
  }),
}));

vi.mock('./processAttachments', () => ({
  processAttachments: vi.fn(),
}));

vi.mock('./processEmailBody', () => ({
  processEmailBody: vi.fn(),
}));

import { validateSenderAuthorization } from './validateSender';
import { processAttachments } from './processAttachments';
import { processEmailBody } from './processEmailBody';

describe('emailIngestionService - processIngestedEmail', () => {
  let mockAdapters: EmailIngestionAdapters;
  let mockParsedEmail: ParsedEmailObject;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        users: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        ingestedEmails: {
          findByMessageId: vi.fn().mockResolvedValue(null), // No duplicate by default
          findByThreadId: vi.fn(),
          findByUserIdWithPagination: vi.fn(),
          findVisibleToUser: vi.fn(),
          releaseEmbargo: vi.fn(),
          findEmbargoedEmailsReadyForRelease: vi.fn(),
          findByPlatformEmailAddress: vi.fn(),
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: 'email123',
            messageId: '<msg@example.com>',
            threadId: 'thread123',
          }),
          findById: vi.fn(),
          update: vi.fn().mockResolvedValue({
            id: 'email123',
            attachments: [],
            bodyFabFileId: null,
          }),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        fabFiles: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        adminSettings: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
      },
      storage: {
        upload: vi.fn().mockResolvedValue('s3://bucket/path'),
        generateSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
      },
    };

    mockParsedEmail = {
      messageId: '<msg123@example.com>',
      from: 'sender@example.com',
      to: 'john.doe@app.example.com',
      subject: 'Test Email',
      date: new Date('2025-01-15T10:00:00Z'),
      text: 'Test body',
      html: '<p>Test body</p>',
      attachments: [],
    };

    // Default mocks for successful flow
    vi.mocked(validateSenderAuthorization).mockResolvedValue({
      userId: 'user123',
      platformEmail: 'john.doe@app.example.com',
      senderEmail: 'sender@example.com',
    });

    vi.mocked(processAttachments).mockResolvedValue([]);
    vi.mocked(processEmailBody).mockResolvedValue({
      bodyMarkdown: '# Converted markdown',
      // bodyFabFileId is undefined by default (not substantial)
    });
  });

  describe('Input Validation', () => {
    it('should throw error for missing rawEmailS3Key', async () => {
      await expect(processIngestedEmail(mockParsedEmail, '', mockAdapters)).rejects.toThrow();
    });

    it('should validate parsedEmail structure with Zod', async () => {
      const validEmail = {
        // All fields optional in schema, so minimal email should work
        from: 'sender@example.com',
      } as any;

      // Should not throw - validation is lenient
      const result = await processIngestedEmail(validEmail, 's3-key', mockAdapters);
      expect(result.emailId).toBe('email123');
    });
  });

  describe('Authorization', () => {
    it('should throw UnauthorizedError when sender is not authorized', async () => {
      vi.mocked(validateSenderAuthorization).mockResolvedValue(null);

      await expect(processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters)).rejects.toThrow(
        UnauthorizedError
      );
    });

    it('should pass platform domain to validator', async () => {
      await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters, {
        platformDomain: '@custom.domain.com',
      });

      expect(validateSenderAuthorization).toHaveBeenCalledWith(
        mockParsedEmail,
        mockAdapters.db.users,
        '@custom.domain.com'
      );
    });
  });

  describe('Idempotency', () => {
    it('should return existing email if already processed', async () => {
      const existingEmail = {
        id: 'existing123',
        messageId: '<msg123@example.com>',
        threadId: 'thread123',
        attachments: [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000 }],
        bodyFabFileId: 'fab123',
      };

      vi.mocked(mockAdapters.db.ingestedEmails.findByMessageId).mockResolvedValue(existingEmail as any);
      vi.mocked(mockAdapters.db.ingestedEmails.findById).mockResolvedValue(existingEmail as any);

      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(result.alreadyProcessed).toBe(true);
      expect(result.emailId).toBe('existing123');
      expect(mockAdapters.db.ingestedEmails.create).not.toHaveBeenCalled();
    });
  });

  describe('Thread ID Generation', () => {
    it('should use In-Reply-To as thread ID when present', async () => {
      const replyEmail = {
        ...mockParsedEmail,
        inReplyTo: '<parent@example.com>',
      };

      await processIngestedEmail(replyEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: '<parent@example.com>',
        })
      );
    });

    it('should use first reference as thread ID when In-Reply-To is missing', async () => {
      const replyEmail = {
        ...mockParsedEmail,
        references: ['<ref1@example.com>', '<ref2@example.com>'],
      };

      await processIngestedEmail(replyEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: '<ref1@example.com>',
        })
      );
    });

    it('should use messageId as thread ID for new conversations', async () => {
      await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: '<msg123@example.com>',
        })
      );
    });

    it('should generate UUID-based thread ID when messageId is missing', async () => {
      const emailWithoutId = {
        ...mockParsedEmail,
        messageId: undefined,
      };

      await processIngestedEmail(emailWithoutId, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: expect.stringMatching(/^thread-[0-9a-f-]{36}$/), // UUID format
        })
      );
    });
  });

  describe('Email Processing', () => {
    it('should create email record with proper fields', async () => {
      await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: '<msg123@example.com>',
          from: 'sender@example.com',
          to: ['john.doe@app.example.com'],
          subject: 'Test Email',
          bodyText: 'Test body',
          bodyHtml: '<p>Test body</p>',
          userId: 'user123',
          platformEmailAddress: 'john.doe@app.example.com',
          rawEmailS3Key: 's3://bucket/email.eml',
          receivedAt: new Date('2025-01-15T10:00:00Z'),
        })
      );
    });

    it('should process attachments', async () => {
      const attachments = [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000, fabFileId: 'fab123' }];
      vi.mocked(processAttachments).mockResolvedValue(attachments);

      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(processAttachments).toHaveBeenCalledWith(
        mockParsedEmail,
        'user123',
        'Test Email',
        expect.anything(),
        undefined
      );
      expect(result.attachments).toEqual(attachments);
    });

    it('should process email body', async () => {
      vi.mocked(processEmailBody).mockResolvedValue({
        bodyMarkdown: '# Email body',
        bodyFabFileId: 'fabfile123',
      });

      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(processEmailBody).toHaveBeenCalledWith(
        mockParsedEmail,
        'user123',
        'email123',
        false,
        expect.objectContaining({
          storage: expect.anything(),
          db: expect.objectContaining({
            fabFiles: expect.anything(),
            adminSettings: expect.anything(),
            users: expect.anything(),
          }),
        }),
        undefined
      );
      expect(result.bodyFabFileCreated).toBe(true);
    });

    it('should pass isNewsletter flag to body processor', async () => {
      await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters, { isNewsletter: true });

      expect(processEmailBody).toHaveBeenCalledWith(
        mockParsedEmail,
        'user123',
        'email123',
        true,
        expect.objectContaining({
          storage: expect.anything(),
          db: expect.objectContaining({
            fabFiles: expect.anything(),
            adminSettings: expect.anything(),
            users: expect.anything(),
          }),
        }),
        undefined
      );
    });

    it('should update email record with attachments and body', async () => {
      const attachments = [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000, fabFileId: 'fab123' }];
      vi.mocked(processAttachments).mockResolvedValue(attachments);
      vi.mocked(processEmailBody).mockResolvedValue({
        bodyMarkdown: '# Email body',
        bodyFabFileId: 'fabfile123',
      });

      await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'email123',
          attachments,
          bodyFabFileId: 'fabfile123',
          bodyMarkdown: '# Email body',
        })
      );
    });
  });

  describe('Return Value', () => {
    it('should return complete result object', async () => {
      const attachments = [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000, fabFileId: 'fab123' }];
      vi.mocked(processAttachments).mockResolvedValue(attachments);
      vi.mocked(processEmailBody).mockResolvedValue({
        bodyMarkdown: '# Email body',
        bodyFabFileId: 'fabfile123',
      });

      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(result).toEqual({
        emailId: 'email123',
        messageId: '<msg123@example.com>',
        threadId: expect.any(String),
        attachments,
        bodyFabFileCreated: true,
        alreadyProcessed: false,
      });
    });

    it('should indicate when body was not created', async () => {
      vi.mocked(processEmailBody).mockResolvedValue({
        bodyMarkdown: '# Email body',
        // no bodyFabFileId
      });

      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(result.bodyFabFileCreated).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should propagate attachment processing errors', async () => {
      vi.mocked(processAttachments).mockRejectedValueOnce(new Error('Attachment failed'));

      await expect(processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters)).rejects.toThrow(
        'Attachment failed'
      );
    });

    it('should propagate body processing errors', async () => {
      vi.mocked(processEmailBody).mockRejectedValueOnce(new Error('Body processing failed'));

      await expect(processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters)).rejects.toThrow(
        'Body processing failed'
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle emails without attachments', async () => {
      const result = await processIngestedEmail(mockParsedEmail, 's3://bucket/email.eml', mockAdapters);

      expect(result.attachments).toEqual([]);
    });

    it('should handle emails without HTML body', async () => {
      const textOnlyEmail = {
        ...mockParsedEmail,
        html: undefined,
      };

      await processIngestedEmail(textOnlyEmail, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyHtml: undefined,
        })
      );
    });

    it('should handle emails with CC and BCC', async () => {
      const emailWithCc = {
        ...mockParsedEmail,
        cc: 'cc1@example.com, cc2@example.com',
        bcc: 'bcc@example.com',
      };

      await processIngestedEmail(emailWithCc, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: ['cc1@example.com', 'cc2@example.com'],
          bcc: ['bcc@example.com'],
        })
      );
    });

    it('should handle emails with references array', async () => {
      const emailWithRefs = {
        ...mockParsedEmail,
        references: ['<ref1@example.com>', '<ref2@example.com>'],
      };

      await processIngestedEmail(emailWithRefs, 's3://bucket/email.eml', mockAdapters);

      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          references: ['<ref1@example.com>', '<ref2@example.com>'],
        })
      );
    });
  });
});

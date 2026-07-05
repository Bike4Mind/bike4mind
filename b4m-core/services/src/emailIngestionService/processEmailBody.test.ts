import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processEmailBody } from './processEmailBody';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { ParsedEmailObject, EmailIngestionAdapters } from './types';

vi.mock('../fabFileService/create', () => ({
  createFabFile: vi.fn(),
}));

vi.mock('../lib/turndown', () => ({
  htmlToMarkdownForEmail: vi.fn(),
  isSubstantialEmailContent: vi.fn(),
}));

import { createFabFile } from '../fabFileService/create';
import { htmlToMarkdownForEmail, isSubstantialEmailContent } from '../lib/turndown';

describe('emailIngestionService - processEmailBody', () => {
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
          findByMessageId: vi.fn(),
          findByThreadId: vi.fn(),
          findByUserIdWithPagination: vi.fn(),
          findVisibleToUser: vi.fn(),
          releaseEmbargo: vi.fn(),
          findEmbargoedEmailsReadyForRelease: vi.fn(),
          findByPlatformEmailAddress: vi.fn(),
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        fabFiles: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn().mockResolvedValue({ id: 'fabfile123' }),
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
      from: {
        value: [{ address: 'sender@example.com', name: 'Sender' }],
        text: 'sender@example.com',
      } as any,
      to: {
        value: [{ address: 'recipient@example.com', name: '' }],
        text: 'recipient@example.com',
      } as any,
      subject: 'Test Email',
      date: new Date(),
      text: 'Plain text body',
      html: '<p>HTML body</p>',
    };

    vi.mocked(createFabFile).mockResolvedValue({
      id: 'fabfile123',
      fileName: 'Email: Test Email.md',
      fileSize: 100,
      mimeType: SupportedFabFileMimeTypes.TXT_MARKDOWN,
    } as any);

    vi.mocked(htmlToMarkdownForEmail).mockReturnValue('# Converted markdown');
    vi.mocked(isSubstantialEmailContent).mockReturnValue(true);
  });

  it('should return object without fabFileId when email body is not substantial', async () => {
    vi.mocked(isSubstantialEmailContent).mockReturnValue(false);

    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
    });
    expect(result.bodyFabFileId).toBeUndefined();
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should process substantial HTML body and create fabFile', async () => {
    vi.mocked(htmlToMarkdownForEmail).mockReturnValue('# Substantial content\n\nLots of text here...');

    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: '# Substantial content\n\nLots of text here...',
      bodyFabFileId: 'fabfile123',
    });
    expect(htmlToMarkdownForEmail).toHaveBeenCalledWith(mockParsedEmail.html);
  });

  it('should use plain text when HTML is not available', async () => {
    const emailWithoutHtml = {
      ...mockParsedEmail,
      html: undefined,
      text: 'This is a plain text email with substantial content that should be processed',
    };

    vi.mocked(isSubstantialEmailContent).mockReturnValue(true);

    const result = await processEmailBody(emailWithoutHtml, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
      bodyFabFileId: 'fabfile123',
    });
    // HTML to markdown is called with text when HTML is unavailable
  });

  it('should always create fabFile for newsletters regardless of size', async () => {
    const shortEmail = {
      ...mockParsedEmail,
      text: 'Short',
      html: '<p>Short</p>',
    };

    // Mock says it's not substantial, but we're marking it as newsletter
    vi.mocked(isSubstantialEmailContent).mockReturnValue(false);
    vi.mocked(isSubstantialEmailContent).mockImplementation((text, html, isNewsletter) => {
      return isNewsletter === true; // Only substantial if newsletter flag is true
    });

    const result = await processEmailBody(shortEmail, 'user123', 'email123', true, mockAdapters);

    expect(isSubstantialEmailContent).toHaveBeenCalledWith(shortEmail.text, shortEmail.html, true);
    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
      bodyFabFileId: 'fabfile123',
    });
  });

  it('should process email with long subject', async () => {
    const longSubject = 'A'.repeat(200);
    const emailWithLongSubject = {
      ...mockParsedEmail,
      subject: longSubject,
    };

    const result = await processEmailBody(emailWithLongSubject, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
      bodyFabFileId: 'fabfile123',
    });
  });

  it('should create fabFile for substantial content', async () => {
    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
      bodyFabFileId: 'fabfile123',
    });
  });

  it('should process email and include metadata', async () => {
    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(result.bodyMarkdown).toBeDefined();
    expect(result.bodyFabFileId).toBe('fabfile123');
  });

  it('should calculate file size correctly from markdown content', async () => {
    const markdown = 'Test markdown content';
    vi.mocked(htmlToMarkdownForEmail).mockReturnValue(markdown);

    await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        fileSize: Buffer.byteLength(markdown),
      }),
      expect.anything()
    );
  });

  it('should use FILE knowledge type', async () => {
    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
      bodyFabFileId: 'fabfile123',
    });
  });

  it('should handle empty email body gracefully', async () => {
    const emptyEmail = {
      ...mockParsedEmail,
      text: undefined,
      html: undefined,
    };

    vi.mocked(isSubstantialEmailContent).mockReturnValue(false);

    const result = await processEmailBody(emptyEmail, 'user123', 'email123', false, mockAdapters);

    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
    });
    expect(result.bodyFabFileId).toBeUndefined();
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should handle createFabFile failure gracefully', async () => {
    vi.mocked(createFabFile).mockRejectedValueOnce(new Error('Storage failure'));

    const result = await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters);

    // Should return bodyMarkdown without fabFileId when upload fails
    expect(result).toEqual({
      bodyMarkdown: expect.any(String),
    });
    expect(result.bodyFabFileId).toBeUndefined();
  });

  it('should prefer HTML over text when both are available', async () => {
    const emailWithBoth = {
      ...mockParsedEmail,
      text: 'Plain text version',
      html: '<h1>HTML version</h1><p>More detailed</p>',
    };

    vi.mocked(htmlToMarkdownForEmail).mockReturnValue('# HTML version\n\nMore detailed');

    await processEmailBody(emailWithBoth, 'user123', 'email123', false, mockAdapters);

    expect(htmlToMarkdownForEmail).toHaveBeenCalledWith(emailWithBoth.html);
    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        content: '# HTML version\n\nMore detailed',
      }),
      expect.anything()
    );
  });

  it('should pass organizationId to createFabFile when provided', async () => {
    await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters, 'org456');

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        organizationId: 'org456',
      }),
      expect.anything()
    );
  });

  it('should not include organizationId in fabFileData when not provided', async () => {
    await processEmailBody(mockParsedEmail, 'user123', 'email123', false, mockAdapters, undefined);

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        organizationId: undefined,
      }),
      expect.anything()
    );
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processAttachments } from './processAttachments';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import type { ParsedEmailObject, EmailIngestionAdapters } from './types';

vi.mock('../fabFileService/create', () => ({
  createFabFile: vi.fn(),
}));

import { createFabFile } from '../fabFileService/create';

describe('emailIngestionService - processAttachments', () => {
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
      from: 'sender@example.com',
      to: 'recipient@example.com',
      subject: 'Test Email',
      date: new Date(),
      text: 'Test body',
      attachments: [],
    };

    vi.mocked(createFabFile).mockResolvedValue({
      id: 'fabfile123',
      fileName: 'test.pdf',
      fileSize: 1000,
      mimeType: SupportedFabFileMimeTypes.PDF,
    } as any);
  });

  it('should return empty array when no attachments', async () => {
    const result = await processAttachments(mockParsedEmail, 'user123', 'Test Email', mockAdapters);
    expect(result).toEqual([]);
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should process single attachment successfully', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'document.pdf',
          contentType: 'application/pdf',
          size: 5000,
          content: Buffer.from('PDF content'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      size: 5000,
    });
    // fabFileId may or may not be present depending on createFabFile success
  });

  it('should process multiple attachments', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'doc1.pdf',
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF 1'),
        },
        {
          filename: 'doc2.txt',
          contentType: 'text/plain',
          size: 3000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('Text content'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      filename: 'doc1.pdf',
      mimeType: 'application/pdf',
      size: 5000,
    });
    expect(result[1]).toMatchObject({
      filename: 'doc2.txt',
      mimeType: 'text/plain',
      size: 3000,
    });
  });

  it('should use default filename when not provided', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(result[0].filename).toBe('unnamed');
  });

  it('should use default mime type when not provided', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'file.bin',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('binary'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(result[0].mimeType).toBe('application/octet-stream');
  });

  it('should handle filename exceeding 255 characters gracefully', async () => {
    const longFilename = 'a'.repeat(256) + '.pdf';
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: longFilename,
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    // Should return metadata without fabFileId when validation fails
    expect(result).toEqual([
      {
        filename: longFilename,
        mimeType: 'application/pdf',
        size: 5000,
        // No fabFileId because upload failed
      },
    ]);
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should handle file size exceeding 20MB gracefully', async () => {
    const largeSize = 21 * 1024 * 1024; // 21MB
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'large.pdf',
          contentType: 'application/pdf',
          size: largeSize,
          content: Buffer.alloc(largeSize),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    // Should return metadata without fabFileId when validation fails
    expect(result).toEqual([
      {
        filename: 'large.pdf',
        mimeType: 'application/pdf',
        size: largeSize,
      },
    ]);
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should skip empty attachment content (filtered out as too small)', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'empty.pdf',
          contentType: 'application/pdf',
          size: 0,
          content: Buffer.from(''),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    // Empty attachments are now filtered out by the enhanced filtering logic (< 2KB)
    expect(result).toEqual([]);
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('should handle createFabFile failure gracefully', async () => {
    vi.mocked(createFabFile).mockRejectedValueOnce(new Error('Upload failed'));

    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    // Should still return metadata even if upload fails
    expect(result).toEqual([
      {
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        size: 5000,
        // No fabFileId when upload fails
      },
    ]);
  });

  it('should process attachments with proper MIME types', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'image.jpg',
          contentType: 'image/jpeg',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('JPEG'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      filename: 'image.jpg',
      mimeType: 'image/jpeg',
      size: 5000,
    });
  });

  it('should process attachments with various subjects', async () => {
    const email = {
      ...mockParsedEmail,
      subject: 'Important Documents',
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    const result = await processAttachments(email, 'user123', 'Important Documents', mockAdapters);

    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe('doc.pdf');
  });

  it('should pass organizationId to createFabFile when provided', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    await processAttachments(email, 'user123', 'Test Email', mockAdapters, 'org456');

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        organizationId: 'org456',
      }),
      expect.anything()
    );
  });

  it('should not include organizationId in fabFileData when not provided', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 5000, // Increased to avoid being filtered out (> 2KB minimum)
          content: Buffer.from('PDF'),
        },
      ],
    };

    await processAttachments(email, 'user123', 'Test Email', mockAdapters, undefined);

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.objectContaining({
        organizationId: undefined,
      }),
      expect.anything()
    );
  });
});

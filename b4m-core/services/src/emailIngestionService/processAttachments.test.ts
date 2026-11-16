import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processAttachments,
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_FILE_SIZE,
  MAX_TOTAL_ATTACHMENT_BYTES_PER_EMAIL,
} from './processAttachments';
import { SupportedFabFileMimeTypes } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { resolveSupportedMimeType } from '@bike4mind/utils';
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
        organizations: { findById: vi.fn() },
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

  it('passes a binary claim through unchanged, so an extensionless executable is refused', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        {
          filename: 'payload',
          contentType: 'application/x-msdownload',
          size: 5000,
          content: Buffer.from('MZ'),
        },
      ],
    };

    await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    const { mimeType } = vi.mocked(createFabFile).mock.calls[0][1] as { mimeType: string };
    expect(mimeType).toBe('application/x-msdownload');
    // createFabFile's own check (the real one) refuses it rather than storing it as text.
    expect(
      resolveSupportedMimeType('payload', mimeType, { extensionlessFallback: SupportedFabFileMimeTypes.TXT_PLAIN })
        .supported
    ).toBe(false);
  });

  it('does not relabel an octet-stream claim as text/plain', async () => {
    const email = {
      ...mockParsedEmail,
      attachments: [
        { filename: 'blob', contentType: 'application/octet-stream', size: 5000, content: Buffer.from('x') },
      ],
    };

    await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(vi.mocked(createFabFile).mock.calls[0][1]).toMatchObject({ mimeType: 'application/octet-stream' });
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

  it('should never put an organizationId on fabFileData (ownership derives from the lake)', async () => {
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

    await processAttachments(email, 'user123', 'Test Email', mockAdapters);

    expect(createFabFile).toHaveBeenCalledWith(
      'user123',
      expect.not.objectContaining({ organizationId: expect.anything() }),
      expect.anything()
    );
  });

  describe('per-email caps', () => {
    const MB = 1024 * 1024;
    const att = (name: string, size = 5000) => ({
      filename: name,
      contentType: 'application/pdf',
      size,
      content: Buffer.from('x'),
    });
    const names = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.pdf`);
    const run = (attachments: ReturnType<typeof att>[]) => {
      vi.mocked(createFabFile).mockResolvedValue({ id: 'ff' } as never);
      return processAttachments({ ...mockParsedEmail, attachments }, 'user123', 'Test Email', mockAdapters);
    };
    const capWarnings = (warn: { mock: { calls: unknown[][] } }) =>
      warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('per-email limit'));
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('stops after the per-email attachment limit', async () => {
      const result = await run(Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 5 }, (_, i) => att(`f${i}.pdf`)));

      expect(result.map(r => r.filename)).toEqual(names(MAX_ATTACHMENTS_PER_EMAIL));
      expect(createFabFile).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_EMAIL);
    });

    it('stops before the attachment that would exceed the total byte limit', async () => {
      const result = await run([att('a.pdf', 10 * MB), att('b.pdf', 10 * MB), att('c.pdf', 6 * MB)]);

      expect(result.map(r => r.filename)).toEqual(['a.pdf', 'b.pdf']);
      expect(createFabFile).toHaveBeenCalledTimes(2);
    });

    it('allows a total of exactly the byte limit', async () => {
      const result = await run([
        att('a.pdf', MAX_FILE_SIZE),
        att('b.pdf', MAX_TOTAL_ATTACHMENT_BYTES_PER_EMAIL - MAX_FILE_SIZE),
      ]);

      expect(result.map(r => r.filename)).toEqual(['a.pdf', 'b.pdf']);
      expect(result.every(r => r.fabFileId)).toBe(true);
      expect(capWarnings(warn)).toHaveLength(0);
    });

    it('does not resume after a cap is hit, even for a small later attachment', async () => {
      const result = await run([att('a.pdf', 20 * MB), att('big.pdf', 10 * MB), att('small.pdf', 5000)]);

      expect(result.map(r => r.filename)).toEqual(['a.pdf']);
    });

    it('does not count phantom parts toward the count cap', async () => {
      const phantoms = Array.from({ length: 30 }, (_, i) => att(`tiny${i}.pdf`, 100));
      const result = await run([...phantoms, ...names(MAX_ATTACHMENTS_PER_EMAIL).map(n => att(n))]);

      expect(result.map(r => r.filename)).toEqual(names(MAX_ATTACHMENTS_PER_EMAIL));
      expect(createFabFile).toHaveBeenCalledTimes(MAX_ATTACHMENTS_PER_EMAIL);
    });

    it('per-file rejects do not consume the byte budget', async () => {
      const result = await run([att('huge.pdf', 21 * MB), att('b.pdf', 10 * MB), att('c.pdf', 10 * MB)]);

      expect(result.map(r => r.filename)).toEqual(['huge.pdf', 'b.pdf', 'c.pdf']);
      expect(result.map(r => Boolean(r.fabFileId))).toEqual([false, true, true]);
      expect(capWarnings(warn)).toHaveLength(0);
    });

    it('per-file rejects do not consume the count budget', async () => {
      const result = await run([
        att('huge.pdf', 21 * MB),
        ...names(MAX_ATTACHMENTS_PER_EMAIL).map(n => att(n, 1000 * 3)),
      ]);

      expect(result.filter(r => r.fabFileId).map(r => r.filename)).toEqual(names(MAX_ATTACHMENTS_PER_EMAIL));
      expect(capWarnings(warn)).toHaveLength(0);
    });

    it('a single attachment over the total limit does not stop later valid ones', async () => {
      const result = await run([att('huge.pdf', 30 * MB), att('small.pdf', 1 * MB)]);

      expect(result.map(r => Boolean(r.fabFileId))).toEqual([false, true]);
      expect(capWarnings(warn)).toHaveLength(0);
    });

    it('logs one count warning with the reason and skipped count', async () => {
      await run(Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 3 }, (_, i) => att(`f${i}.pdf`)));

      expect(capWarnings(warn)).toHaveLength(1);
      expect(capWarnings(warn)[0]).toContain('Skipping 3 remaining');
      expect(capWarnings(warn)[0]).toContain(`limit of ${MAX_ATTACHMENTS_PER_EMAIL} attachments`);
    });

    it('logs one byte warning with the reason and skipped count', async () => {
      await run([att('a.pdf', 20 * MB), att('b.pdf', 10 * MB), att('c.pdf', 1 * MB)]);

      expect(capWarnings(warn)).toHaveLength(1);
      expect(capWarnings(warn)[0]).toContain('Skipping 2 remaining');
      expect(capWarnings(warn)[0]).toContain('total bytes');
    });

    it('does not count trailing phantom parts in the skipped count', async () => {
      await run([
        ...names(MAX_ATTACHMENTS_PER_EMAIL + 1).map(n => att(n)),
        { ...att('smime.p7s', 3000), contentType: 'application/pkcs7-signature' },
        att('tiny.pdf', 100),
      ]);

      expect(capWarnings(warn)[0]).toContain('Skipping 1 remaining');
    });
  });
});

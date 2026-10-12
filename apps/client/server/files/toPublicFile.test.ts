import { describe, expect, it } from 'vitest';
import { FileResponseSchema, FileSummarySchema } from '@bike4mind/common';
import { toPublicFile, toPublicFileSummary } from './toPublicFile';

// A FabFile carrying internal fields the public shapes must never echo.
const doc = {
  id: '507f1f77bcf86cd799439011',
  _id: '507f1f77bcf86cd799439011',
  userId: 'owner-1',
  fileName: 'reference.png',
  mimeType: 'image/png',
  fileSize: 482133,
  moderationStatus: 'clean' as const,
  fileUrl: 'https://cdn.example/key.png?Signature=abc',
  fileUrlExpireAt: new Date('2026-09-30T12:00:00.000Z'),
  createdAt: new Date('2026-09-29T12:00:00.000Z'),
  filePath: 'secret/path.png',
  notes: 'private',
  tags: [{ name: 'datalake:secret', strength: 1 }],
  users: [{ userId: 'someone-else', permissions: ['read'] }],
};

describe('toPublicFile', () => {
  it('projects only the allowlisted fields', () => {
    const file = toPublicFile(doc);
    expect(FileResponseSchema.strict().safeParse(file).success).toBe(true);
    expect(file).toEqual({
      id: doc.id,
      file_name: 'reference.png',
      mime_type: 'image/png',
      file_size: 482133,
      moderation_status: 'clean',
      download_url: doc.fileUrl,
      download_url_expires_at: '2026-09-30T12:00:00.000Z',
      created_at: '2026-09-29T12:00:00.000Z',
    });
  });

  it('withholds the download URL until moderation clears the file', () => {
    expect(toPublicFile({ ...doc, moderationStatus: 'pending' })).toMatchObject({
      download_url: null,
      download_url_expires_at: null,
    });
  });

  it('has no download URL for a clean file that carries no signed URL', () => {
    expect(toPublicFile({ ...doc, fileUrl: undefined })).toMatchObject({
      download_url: null,
      download_url_expires_at: null,
    });
  });

  it('serves a clean file whose URL has no recorded expiry, with a null expiry', () => {
    expect(toPublicFile({ ...doc, fileUrlExpireAt: undefined })).toMatchObject({
      download_url: doc.fileUrl,
      download_url_expires_at: null,
    });
  });
});

describe('toPublicFileSummary', () => {
  it('drops the download fields and every internal field', () => {
    const summary = toPublicFileSummary(doc);
    expect(FileSummarySchema.strict().safeParse(summary).success).toBe(true);
    expect(Object.keys(summary).sort()).toEqual([
      'created_at',
      'file_name',
      'file_size',
      'id',
      'mime_type',
      'moderation_status',
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { isExecutableUploadMimeType, isAllowedImageMimeType, FileGeneratePresignedUrlRequestInput } from './file';

describe('isExecutableUploadMimeType', () => {
  it('flags browser-executable document types', () => {
    expect(isExecutableUploadMimeType('text/html')).toBe(true);
    expect(isExecutableUploadMimeType('image/svg+xml')).toBe(true);
    expect(isExecutableUploadMimeType('application/xhtml+xml')).toBe(true);
  });

  it('ignores charset params and casing', () => {
    expect(isExecutableUploadMimeType('TEXT/HTML; charset=utf-8')).toBe(true);
    expect(isExecutableUploadMimeType('Image/SVG+XML')).toBe(true);
  });

  it('does not flag ordinary upload types', () => {
    expect(isExecutableUploadMimeType('image/png')).toBe(false);
    expect(isExecutableUploadMimeType('application/pdf')).toBe(false);
    expect(isExecutableUploadMimeType('text/plain')).toBe(false);
  });
});

describe('isAllowedImageMimeType', () => {
  it('allows raster image types', () => {
    expect(isAllowedImageMimeType('image/png')).toBe(true);
    expect(isAllowedImageMimeType('image/jpeg')).toBe(true);
    expect(isAllowedImageMimeType('image/webp')).toBe(true);
  });

  it('rejects svg and non-image types', () => {
    expect(isAllowedImageMimeType('image/svg+xml')).toBe(false);
    expect(isAllowedImageMimeType('text/html')).toBe(false);
    expect(isAllowedImageMimeType('application/pdf')).toBe(false);
  });
});

describe('FileGeneratePresignedUrlRequestInput', () => {
  const valid = { fileName: 'a.png', mimeType: 'image/png', fileSize: 1024 };
  const parse = (over: Record<string, unknown>) =>
    FileGeneratePresignedUrlRequestInput.safeParse({ ...valid, ...over });
  const failedOn = (r: ReturnType<typeof parse>, field: string) =>
    !r.success && r.error.issues.some(i => i.path[0] === field);

  it('accepts a valid request', () => {
    expect(parse({}).success).toBe(true);
  });

  it('accepts boundary values', () => {
    expect(parse({ fileSize: 1 }).success).toBe(true);
    expect(parse({ fileName: 'a'.repeat(255) }).success).toBe(true);
  });

  it.each([10.5, 0, -1])('rejects fileSize %s', fileSize => {
    expect(failedOn(parse({ fileSize }), 'fileSize')).toBe(true);
  });

  it.each(['', 'a'.repeat(256)])('rejects fileName of length %#', fileName => {
    expect(failedOn(parse({ fileName }), 'fileName')).toBe(true);
  });
});

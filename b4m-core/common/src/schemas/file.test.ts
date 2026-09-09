import { describe, it, expect } from 'vitest';
import { isExecutableUploadMimeType, isAllowedImageMimeType } from './file';

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

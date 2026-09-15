import { describe, it, expect } from 'vitest';
import { isImageServeable } from './isImageServeable';

describe('isImageServeable (upload moderation serve-gate)', () => {
  it('serves a clean image', () => {
    expect(isImageServeable({ mimeType: 'image/png', moderationStatus: 'clean' })).toBe(true);
  });

  it('refuses a pending or scanning image', () => {
    expect(isImageServeable({ mimeType: 'image/png', moderationStatus: 'pending' })).toBe(false);
    expect(isImageServeable({ mimeType: 'image/jpeg', moderationStatus: 'scanning' })).toBe(false);
  });

  it('refuses a blocked image', () => {
    expect(isImageServeable({ mimeType: 'image/jpeg', moderationStatus: 'blocked' })).toBe(false);
  });

  it('refuses an image with a missing moderationStatus (fail-closed for legacy rows)', () => {
    // A legacy image row (predating this gate) has moderationStatus undefined. Treat as not-yet-clean.
    expect(isImageServeable({ mimeType: 'image/png', moderationStatus: undefined })).toBe(false);
    expect(isImageServeable({ mimeType: 'image/png', moderationStatus: null })).toBe(false);
  });

  // A non-image's mimeType is client-declared and only corrected by the async
  // S3 scan; during that window a spoofed `application/pdf`+PNG must not be served just
  // because the declared mimeType isn't "image/*". So non-images are gated identically to
  // images: held until `moderationStatus` reaches 'clean' (which `objectCreated` sets
  // promptly for real non-images, without a Rekognition scan).
  it('refuses a non-image that has not yet cleared moderation (pending/scanning/unset)', () => {
    expect(isImageServeable({ mimeType: 'application/pdf', moderationStatus: 'pending' })).toBe(false);
    expect(isImageServeable({ mimeType: 'application/pdf', moderationStatus: 'scanning' })).toBe(false);
    expect(isImageServeable({ mimeType: undefined, moderationStatus: undefined })).toBe(false);
  });

  it('serves a non-image once moderationStatus is clean', () => {
    expect(isImageServeable({ mimeType: 'application/pdf', moderationStatus: 'clean' })).toBe(true);
    expect(isImageServeable({ mimeType: undefined, moderationStatus: 'clean' })).toBe(true);
  });

  it('refuses a non-image that was blocked (e.g. unsupported format the scanner could not clear)', () => {
    expect(isImageServeable({ mimeType: 'application/pdf', moderationStatus: 'blocked' })).toBe(false);
  });
});

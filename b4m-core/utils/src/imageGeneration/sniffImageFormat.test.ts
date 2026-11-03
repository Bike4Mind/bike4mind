import { describe, it, expect } from 'vitest';
import { sniffImageFormat } from './sniffImageFormat';

describe('sniffImageFormat', () => {
  it.each([
    ['PNG', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00], { mimeType: 'image/png', extension: 'png' }],
    ['JPEG', [0xff, 0xd8, 0xff, 0xe0, 0x00], { mimeType: 'image/jpeg', extension: 'jpg' }],
    [
      'WebP',
      [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
      { mimeType: 'image/webp', extension: 'webp' },
    ],
  ])('recognizes %s', (_name, bytes, expected) => {
    expect(sniffImageFormat(Buffer.from(bytes))).toEqual(expected);
  });

  it.each([
    ['GIF', Buffer.from('GIF89a')],
    ['a non-WebP RIFF container (WAV)', Buffer.from('RIFF\0\0\0\0WAVE')],
    ['a truncated PNG signature', Buffer.from([0x89, 0x50, 0x4e])],
    ['an empty buffer', Buffer.alloc(0)],
  ])('returns undefined for %s', (_name, buffer) => {
    expect(sniffImageFormat(buffer)).toBeUndefined();
  });
});

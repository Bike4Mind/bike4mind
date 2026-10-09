import { describe, expect, it } from 'vitest';
import { videoFileExtension } from './fileType';

describe('videoFileExtension', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['VIDEO/MP4', 'mp4'],
    ['video/webm', 'webm'],
  ])('maps %s to %s', (contentType, extension) => {
    expect(videoFileExtension(contentType)).toBe(extension);
  });

  it.each(['text/html', 'image/png', 'video/x-unknown', ''])('refuses %s', contentType => {
    expect(videoFileExtension(contentType)).toBeNull();
  });
});

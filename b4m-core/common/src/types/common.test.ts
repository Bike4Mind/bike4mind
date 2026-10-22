import { describe, expect, it } from 'vitest';
import { isMediaOnlyMimeType, isStorableFabFileMimeType, isVideoMimeType } from './common';

describe('media-only MIME guards', () => {
  it.each(['video/mp4', 'VIDEO/MP4', 'video/webm; codecs=vp9'])('isVideoMimeType(%s) is true', m => {
    expect(isVideoMimeType(m)).toBe(true);
  });

  it.each([null, undefined, '', 'audio/mpeg', 'application/pdf'])('isVideoMimeType(%s) is false', m => {
    expect(isVideoMimeType(m)).toBe(false);
  });

  it('treats audio and video as media-only and nothing else', () => {
    expect(isMediaOnlyMimeType('audio/mpeg')).toBe(true);
    expect(isMediaOnlyMimeType('video/mp4')).toBe(true);
    expect(isMediaOnlyMimeType('application/pdf')).toBe(false);
  });

  it('allows video to be stored as a FabFile', () => {
    expect(isStorableFabFileMimeType('video/mp4')).toBe(true);
  });
});

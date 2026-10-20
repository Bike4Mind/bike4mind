import { describe, it, expect } from 'vitest';
import { pickSlideVideo, storageKeyOf, videoUrlsOf } from './whatsNewSlideMedia';

const both = {
  landscapeUrl: 'https://b.s3.us-east-2.amazonaws.com/modals/wide.mp4',
  landscapePosterUrl: 'https://b.s3.us-east-2.amazonaws.com/modals/wide.png',
  portraitUrl: 'https://b.s3.us-east-2.amazonaws.com/modals/tall.mp4',
  portraitPosterUrl: null,
};

describe('pickSlideVideo', () => {
  it('uses landscape on desktop and portrait on mobile', () => {
    expect(pickSlideVideo(both, false)).toEqual({
      src: both.landscapeUrl,
      poster: both.landscapePosterUrl,
      orientation: 'landscape',
    });
    expect(pickSlideVideo(both, true)).toEqual({ src: both.portraitUrl, poster: null, orientation: 'portrait' });
  });

  it('falls back to the other orientation', () => {
    expect(pickSlideVideo({ ...both, landscapeUrl: null }, false)?.orientation).toBe('portrait');
    expect(pickSlideVideo({ ...both, portraitUrl: null }, true)?.orientation).toBe('landscape');
  });

  it('is null without a video file', () => {
    expect(pickSlideVideo(null, false)).toBeNull();
    expect(pickSlideVideo({ landscapePosterUrl: 'https://x.test/p.png' }, false)).toBeNull();
  });
});

describe('videoUrlsOf', () => {
  it('lists the set urls', () => {
    expect(videoUrlsOf(both)).toEqual([both.landscapeUrl, both.landscapePosterUrl, both.portraitUrl]);
    expect(videoUrlsOf(undefined)).toEqual([]);
  });
});

describe('storageKeyOf', () => {
  it('returns the key of an S3 url', () => {
    expect(storageKeyOf('https://b.s3.us-east-2.amazonaws.com/modals/a%20b.mp4')).toBe('modals/a%20b.mp4');
  });

  it('is null for other urls', () => {
    expect(storageKeyOf('https://cdn.example.com/modals/a.mp4')).toBeNull();
    expect(storageKeyOf('not a url')).toBeNull();
  });
});

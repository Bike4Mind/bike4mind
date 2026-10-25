import { describe, it, expect } from 'vitest';
import {
  isMediaRouteUrl,
  localizeMediaRouteUrls,
  pickSlideStill,
  pickSlideVideo,
  stillUrlsOf,
  storageKeyOf,
  videoUrlsOf,
  withRetryParam,
} from './whatsNewSlideMedia';

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

describe('pickSlideStill', () => {
  it('uses landscape on desktop and portrait on mobile', () => {
    const image = { landscapeUrl: 'w.png', portraitUrl: 't.png' };
    expect(pickSlideStill(image, false)).toEqual({ src: 'w.png', orientation: 'landscape' });
    expect(pickSlideStill(image, true)).toEqual({ src: 't.png', orientation: 'portrait' });
  });

  it('falls back to the other orientation', () => {
    expect(pickSlideStill({ portraitUrl: 't.png' }, false)).toEqual({ src: 't.png', orientation: 'portrait' });
    expect(pickSlideStill({ landscapeUrl: 'w.png' }, true)).toEqual({ src: 'w.png', orientation: 'landscape' });
  });

  it('is null without a still file', () => {
    for (const v of [null, undefined, {}, { landscapeUrl: null, portraitUrl: null }]) {
      expect(pickSlideStill(v, false)).toBeNull();
    }
  });
});

describe('stillUrlsOf', () => {
  it('lists the set urls', () => {
    expect(stillUrlsOf({ landscapeUrl: 'w.png', portraitUrl: null })).toEqual(['w.png']);
    expect(stillUrlsOf({ landscapeUrl: 'w.png', portraitUrl: 't.png' })).toEqual(['w.png', 't.png']);
    expect(stillUrlsOf(null)).toEqual([]);
  });
});

describe('storageKeyOf', () => {
  it('returns the key of an S3 url', () => {
    expect(storageKeyOf('https://b.s3.us-east-2.amazonaws.com/modals/a%20b.mp4')).toBe('modals/a%20b.mp4');
  });

  it('is null for other urls', () => {
    expect(storageKeyOf('https://d111.cloudfront.net/modals/a.mp4')).toBeNull();
    expect(storageKeyOf('not a url')).toBeNull();
  });
});

describe('localizeMediaRouteUrls', () => {
  const HERE = 'https://chat.example.com';
  const UPSTREAM = 'https://upstream.example.com';

  it("serves this deployment's media route from the browsed origin, whatever origin the feed named", () => {
    expect(
      localizeMediaRouteUrls(
        {
          landscapeUrl: 'https://app.example.com/api/v1/whats-new/media/n1/landscape',
          landscapePosterUrl: 'https://chat.example.com/api/v1/whats-new/media/n1/landscape-poster',
          portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
          portraitPosterUrl: null,
        },
        UPSTREAM,
        HERE
      )
    ).toEqual({
      landscapeUrl: '/api/v1/whats-new/media/n1/landscape',
      landscapePosterUrl: '/api/v1/whats-new/media/n1/landscape-poster',
      portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
      portraitPosterUrl: null,
    });
  });

  it("leaves the upstream feed's media route on the upstream", () => {
    const url = `${UPSTREAM}/api/v1/whats-new/media/n1/landscape`;
    expect(localizeMediaRouteUrls({ landscapeUrl: url }, UPSTREAM, HERE).landscapeUrl).toBe(url);
  });

  it('localizes a still image the same way as a video', () => {
    expect(
      localizeMediaRouteUrls(
        {
          landscapeUrl: 'https://app.example.com/api/v1/whats-new/media/n1/image-landscape',
          portraitUrl: 'https://upstream.example.com/api/v1/whats-new/media/n1/image-portrait',
        },
        UPSTREAM,
        HERE
      )
    ).toEqual({
      landscapeUrl: '/api/v1/whats-new/media/n1/image-landscape',
      portraitUrl: 'https://upstream.example.com/api/v1/whats-new/media/n1/image-portrait',
    });
  });
});

describe('isMediaRouteUrl and withRetryParam', () => {
  it('recognizes relative and absolute media route URLs only', () => {
    expect(isMediaRouteUrl('/api/v1/whats-new/media/n1/landscape', 'https://a.test')).toBe(true);
    expect(isMediaRouteUrl('https://up.test/api/v1/whats-new/media/n1/portrait', 'https://a.test')).toBe(true);
    expect(isMediaRouteUrl('https://b.s3.us-east-2.amazonaws.com/modals/wide.mp4', 'https://a.test')).toBe(false);
  });

  it('adds the retry param to either form', () => {
    expect(withRetryParam('/api/v1/whats-new/media/n1/landscape')).toBe('/api/v1/whats-new/media/n1/landscape?retry=1');
    expect(withRetryParam('/m?x=1')).toBe('/m?x=1&retry=1');
  });
});

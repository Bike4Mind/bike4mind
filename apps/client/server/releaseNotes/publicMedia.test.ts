import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUpstreamMediaUrl, ownModalMediaKey, toPublicFeedVideo } from './publicMedia';

const BUCKET = 'files-bucket';
const upload = (key: string) => `https://${BUCKET}.s3.us-east-2.amazonaws.com/${key}`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ownModalMediaKey', () => {
  it('returns the key of an upload under modals/ in the files bucket', () => {
    expect(ownModalMediaKey(upload('modals/a%20b.mp4'), BUCKET)).toBe('modals/a b.mp4');
    expect(ownModalMediaKey(`https://${BUCKET}.s3.amazonaws.com/modals/x.mp4`, BUCKET)).toBe('modals/x.mp4');
  });

  it('refuses other keys, buckets, hosts and schemes', () => {
    expect(ownModalMediaKey(upload('exports/leak.json'), BUCKET)).toBeNull();
    expect(ownModalMediaKey('https://other-bucket.s3.us-east-2.amazonaws.com/modals/x.mp4', BUCKET)).toBeNull();
    expect(ownModalMediaKey('https://d111.cloudfront.net/modals/x.mp4', BUCKET)).toBeNull();
    expect(ownModalMediaKey(`https://${BUCKET}.s3.example.com/modals/x.mp4`, BUCKET)).toBeNull();
    expect(ownModalMediaKey(`http://${BUCKET}.s3.us-east-2.amazonaws.com/modals/x.mp4`, BUCKET)).toBeNull();
    expect(ownModalMediaKey('not a url', BUCKET)).toBeNull();
  });
});

describe('toPublicFeedVideo', () => {
  const video = {
    landscapeUrl: upload('modals/wide.mp4'),
    landscapePosterUrl: upload('modals/wide.jpg'),
    portraitUrl: 'https://d111.cloudfront.net/tall.mp4',
    portraitPosterUrl: null,
  };

  it('points uploads at the media route on APP_URL and keeps linked URLs', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/');
    expect(toPublicFeedVideo('n1', video, BUCKET)).toEqual({
      landscape_url: 'https://app.example.com/api/v1/whats-new/media/n1/landscape',
      landscape_poster_url: 'https://app.example.com/api/v1/whats-new/media/n1/landscape-poster',
      portrait_url: 'https://d111.cloudfront.net/tall.mp4',
      portrait_poster_url: null,
    });
  });

  it('serves the media route relative to the reader when APP_URL is unset', () => {
    vi.stubEnv('APP_URL', '');
    expect(toPublicFeedVideo('n1', video, BUCKET)).toEqual({
      landscape_url: '/api/v1/whats-new/media/n1/landscape',
      landscape_poster_url: '/api/v1/whats-new/media/n1/landscape-poster',
      portrait_url: 'https://d111.cloudfront.net/tall.mp4',
      portrait_poster_url: null,
    });
  });
});

describe('isUpstreamMediaUrl', () => {
  const feed = 'https://up.example.com/api/v1/whats-new';

  it('accepts the media route on the feed origin only', () => {
    expect(isUpstreamMediaUrl('https://up.example.com/api/v1/whats-new/media/n1/landscape', feed)).toBe(true);
    expect(isUpstreamMediaUrl('https://evil.example.com/api/v1/whats-new/media/n1/landscape', feed)).toBe(false);
    expect(isUpstreamMediaUrl('https://up.example.com/api/v1/me', feed)).toBe(false);
    expect(isUpstreamMediaUrl('http://up.example.com/api/v1/whats-new/media/n1/landscape', feed)).toBe(false);
  });
});

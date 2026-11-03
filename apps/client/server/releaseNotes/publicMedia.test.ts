import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUpstreamMediaUrl, ownModalMediaKey, toPublicFeedImage, toPublicFeedVideo } from './publicMedia';

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

  it('reads the fields of a Mongoose subdocument, whose values sit behind prototype accessors', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/');
    class VideoSubdocument {
      get landscapeUrl() {
        return upload('modals/wide.mp4');
      }
      get landscapePosterUrl() {
        return upload('modals/wide.jpg');
      }
      get portraitUrl() {
        return 'https://d111.cloudfront.net/tall.mp4';
      }
      get portraitPosterUrl() {
        return null;
      }
    }
    const subdocument = new VideoSubdocument();
    expect(toPublicFeedVideo('n1', subdocument, BUCKET)).toEqual({
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

  it('serializes absent and null video fields as null', () => {
    expect(toPublicFeedVideo('n1', { landscapeUrl: null }, BUCKET)).toEqual({
      landscape_url: null,
      landscape_poster_url: null,
      portrait_url: null,
      portrait_poster_url: null,
    });
  });
});

describe('toPublicFeedImage', () => {
  const image = { landscapeUrl: upload('modals/still.png'), portraitUrl: 'https://d111.cloudfront.net/tall.png' };

  it('points uploads at the image media routes on APP_URL and keeps linked URLs', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/');
    expect(toPublicFeedImage('n1', image, BUCKET)).toEqual({
      landscape_url: 'https://app.example.com/api/v1/whats-new/media/n1/image-landscape',
      portrait_url: 'https://d111.cloudfront.net/tall.png',
    });
  });

  it('reads image fields through prototype accessors without mutating the source', () => {
    vi.stubEnv('APP_URL', 'https://app.example.com/');
    class ImageSubdocument {
      get landscapeUrl() {
        return upload('modals/still.png');
      }
      get portraitUrl() {
        return 'https://d111.cloudfront.net/tall.png';
      }
    }
    const subdocument = new ImageSubdocument();

    expect(toPublicFeedImage('n1', subdocument, BUCKET)).toEqual({
      landscape_url: 'https://app.example.com/api/v1/whats-new/media/n1/image-landscape',
      portrait_url: 'https://d111.cloudfront.net/tall.png',
    });
    expect(subdocument.landscapeUrl).toBe(upload('modals/still.png'));
    expect(subdocument.portraitUrl).toBe('https://d111.cloudfront.net/tall.png');
  });

  it('serializes absent and null image fields as null', () => {
    expect(toPublicFeedImage('n1', { landscapeUrl: null }, BUCKET)).toEqual({
      landscape_url: null,
      portrait_url: null,
    });
  });

  it('serves the media route relative to the reader when APP_URL is unset', () => {
    vi.stubEnv('APP_URL', '');
    expect(toPublicFeedImage('n1', image, BUCKET)).toEqual({
      landscape_url: '/api/v1/whats-new/media/n1/image-landscape',
      portrait_url: 'https://d111.cloudfront.net/tall.png',
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

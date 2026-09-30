import { describe, it, expect } from 'vitest';
import { parseYouTube, isYouTubeUrl } from '../utils';

const ID = 'dQw4w9WgXcQ';

describe('parseYouTube', () => {
  it('returns the id with start 0 when no offset is present', () => {
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}`)).toEqual({ id: ID, start: 0 });
    expect(parseYouTube(`https://youtu.be/${ID}`)).toEqual({ id: ID, start: 0 });
    expect(parseYouTube(`https://www.youtube-nocookie.com/embed/${ID}`)).toEqual({ id: ID, start: 0 });
    expect(parseYouTube(`https://www.youtube.com/shorts/${ID}`)).toEqual({ id: ID, start: 0 });
  });

  it('reads ?t= on youtu.be and watch links', () => {
    expect(parseYouTube(`https://youtu.be/${ID}?t=42`)).toEqual({ id: ID, start: 42 });
    expect(parseYouTube(`https://www.youtube.com/watch?v=${ID}&t=42`)).toEqual({ id: ID, start: 42 });
  });

  it('reads ?start= on embed links', () => {
    expect(parseYouTube(`https://www.youtube-nocookie.com/embed/${ID}?start=7`)).toEqual({ id: ID, start: 7 });
  });

  it('accepts the seconds-suffix and h/m/s forms', () => {
    expect(parseYouTube(`https://youtu.be/${ID}?t=42s`)?.start).toBe(42);
    expect(parseYouTube(`https://youtu.be/${ID}?t=1m30s`)?.start).toBe(90);
    expect(parseYouTube(`https://youtu.be/${ID}?t=1h2m3s`)?.start).toBe(3723);
    expect(parseYouTube(`https://youtu.be/${ID}?t=2m`)?.start).toBe(120);
  });

  it('treats an unparseable offset as no offset rather than rejecting the link', () => {
    expect(parseYouTube(`https://youtu.be/${ID}?t=soon`)).toEqual({ id: ID, start: 0 });
    expect(parseYouTube(`https://youtu.be/${ID}?t=`)).toEqual({ id: ID, start: 0 });
  });

  it('returns null for non-YouTube and malformed input', () => {
    expect(parseYouTube('')).toBeNull();
    expect(parseYouTube('not a url')).toBeNull();
    expect(parseYouTube(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTube('https://www.youtube.com/watch?v=short')).toBeNull();
    expect(isYouTubeUrl(`https://youtu.be/${ID}?t=42`)).toBe(true);
    expect(isYouTubeUrl('https://example.com/x.gif')).toBe(false);
  });
});

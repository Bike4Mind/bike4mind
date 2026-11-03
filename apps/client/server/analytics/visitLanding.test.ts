import { describe, it, expect } from 'vitest';
import { MAX_LANDING_PATH, cleanLandingPath, readVisitLanding, referrerOrigin } from './visitLanding';

describe('referrerOrigin', () => {
  it('keeps only the origin of an http(s) referrer', () => {
    expect(referrerOrigin('https://www.google.com/search?q=private+words')).toBe('https://www.google.com');
    expect(referrerOrigin('http://news.example.com:8080/a/b#c')).toBe('http://news.example.com:8080');
  });

  it('drops anything that is no web URL', () => {
    for (const raw of ['', 'not a url', 'android-app://com.example/', 'javascript:alert(1)', 42, null, undefined]) {
      expect(referrerOrigin(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('cleanLandingPath', () => {
  it('keeps the path alone, cut at the query or fragment', () => {
    expect(cleanLandingPath('/pricing?ref=mail&token=abc')).toBe('/pricing');
    expect(cleanLandingPath('/docs#install')).toBe('/docs');
    expect(cleanLandingPath('/')).toBe('/');
  });

  it('sends a secret-shaped segment as :token and keeps the rest of the path', () => {
    expect(cleanLandingPath('/share/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('/share/:token');
    expect(cleanLandingPath('/notebooks/65f1c0ffee0ddba11ad5eed1')).toBe('/notebooks/:token');
    expect(cleanLandingPath('/invite/aB3dE5fG7hJ9kL1mN3pQ')).toBe('/invite/:token');
    // Slugs and short ids pass unchanged.
    expect(cleanLandingPath('/blog/how-to-learn-kanji-in-2024')).toBe('/blog/how-to-learn-kanji-in-2024');
    expect(cleanLandingPath('/u/42')).toBe('/u/42');
    expect(cleanLandingPath('/blog/caf%C3%A9')).toBe('/blog/caf%C3%A9');
  });

  it('redacts each id in a bulk share link, however the comma is written', () => {
    const [a, b] = ['65a1b2c3d4e5f60718293a4b', '65a1b2c3d4e5f60718293a4c'];
    expect(cleanLandingPath(`/share/${a},${b}`)).toBe('/share/:token,:token');
    expect(cleanLandingPath(`/share/${a}%2C${b}`)).toBe('/share/:token%2C:token');
  });

  it('sends nothing for a path no browser could send', () => {
    for (const raw of ['/<script>alert(1)</script>', '/a\nb', '/a\u0000b', '/a b', '/caf\u00e9', '/a"b']) {
      expect(cleanLandingPath(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('sends nothing for a path holding an address, or for anything that is no path', () => {
    for (const raw of [
      '/users/someone@example.com',
      '/u/someone%40example.com',
      'pricing',
      'https://x.com/',
      7,
      null,
    ]) {
      expect(cleanLandingPath(raw), String(raw)).toBeUndefined();
    }
  });

  it('keeps at most the cap', () => {
    expect(cleanLandingPath(`/${'page-'.repeat(80)}`)).toHaveLength(MAX_LANDING_PATH);
  });
});

describe('readVisitLanding', () => {
  it('reads both from the beacon body, each only when it passes', () => {
    expect(readVisitLanding({ referrer: 'https://t.co/abc', landingPath: '/x?y' })).toEqual({
      referrer: 'https://t.co',
      landingPath: '/x',
    });
    expect(readVisitLanding({ referrer: 'nope', landingPath: '/a@b.c' })).toEqual({});
  });

  it('reads nothing from a body that is no object', () => {
    for (const body of [undefined, null, '', 'referrer=https://x.com', 3]) {
      expect(readVisitLanding(body), String(body)).toEqual({});
    }
  });
});

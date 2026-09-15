// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
  VISIT_COOKIE,
  VISIT_TTL_SECONDS,
  isProbableBot,
  mintVisitId,
  readVisitId,
  visitCookieHeader,
} from './visitSession';

describe('mintVisitId', () => {
  it('mints a distinct 32-character hex id each time', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintVisitId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('readVisitId', () => {
  it('reads the visit cookie from among others', () => {
    const id = mintVisitId();
    expect(readVisitId(`b4m_utm=%7B%22source%22%3A%22email%22%7D; ${VISIT_COOKIE}=${id}; other=1`)).toBe(id);
  });

  it('returns undefined when there is no cookie header at all', () => {
    expect(readVisitId(undefined)).toBeUndefined();
    expect(readVisitId('')).toBeUndefined();
  });

  it('returns undefined when the visit cookie is absent', () => {
    expect(readVisitId('b4m_utm=x; session=y')).toBeUndefined();
  });

  // The cookie is client-controlled and its value is stored on every event and grouped on
  // downstream. Without the shape check a visitor could choose their own session id: one
  // shared constant to collapse every visit into one, or a fresh 200-character string per
  // request to inflate the count and the stored data with it.
  it.each([
    ['a value this server never minted', 'not-a-visit-id'],
    ['an id of the wrong length', 'abcdef'],
    ['non-hex characters', 'z'.repeat(32)],
    ['uppercase hex', 'A'.repeat(32)],
    ['a long string', 'a'.repeat(300)],
    ['an empty value', ''],
  ])('rejects %s', (_label, value) => {
    expect(readVisitId(`${VISIT_COOKIE}=${value}`)).toBeUndefined();
  });
});

describe('visitCookieHeader', () => {
  it('sets the sliding window, hides the cookie from scripts, and survives a referred arrival', () => {
    const id = mintVisitId();
    const header = visitCookieHeader(id, { secure: true });
    expect(header).toContain(`${VISIT_COOKIE}=${id}`);
    expect(header).toContain(`Max-Age=${VISIT_TTL_SECONDS}`);
    expect(header).toContain('HttpOnly');
    // Lax, not Strict: under Strict a visitor arriving by a top-level campaign or search
    // link would not present the cookie on that navigation, and the arrival that matters
    // most to an acquisition funnel would be counted twice.
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');
  });

  it('omits Secure where the dev server has no TLS', () => {
    expect(visitCookieHeader(mintVisitId(), { secure: false })).not.toContain('Secure');
  });

  it('round-trips through readVisitId', () => {
    const id = mintVisitId();
    const cookie = visitCookieHeader(id, { secure: true }).split(';')[0];
    expect(readVisitId(cookie)).toBe(id);
  });
});

describe('isProbableBot', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0'],
  ])('counts a real browser: %s', ua => {
    expect(isProbableBot(ua)).toBe(false);
  });

  it.each([
    ['Googlebot/2.1 (+http://www.google.com/bot.html)'],
    ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
    ['Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/124.0.0.0'],
    ['curl/8.4.0'],
    ['python-requests/2.31.0'],
    ['Chrome-Lighthouse'],
  ])('filters a non-human agent: %s', ua => {
    expect(isProbableBot(ua)).toBe(true);
  });

  it('treats a missing or blank user-agent as non-human, because browsers always send one', () => {
    expect(isProbableBot(undefined)).toBe(true);
    expect(isProbableBot('   ')).toBe(true);
  });
});

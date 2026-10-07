import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attributionParams } from './attributionCookies';
import { clearAttributionCookies } from './utmCapture';
import { readAcquisitionTouches } from '@server/analytics/acquisition';

const setCookie = (name: string, value: unknown) => {
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; path=/`;
};

function clearCookies() {
  for (const cookie of document.cookie.split('; ')) {
    document.cookie = `${cookie.split('=')[0]}=; path=/; max-age=0`;
  }
  localStorage.removeItem('cookie_consent');
}

beforeEach(() => {
  clearCookies();
  localStorage.setItem('cookie_consent', 'granted');
});
afterEach(clearCookies);

describe('attributionParams', () => {
  it('uses app first and last touches after the session cookie expires, matching checkout', () => {
    setCookie('b4m_app_first_touch', { source: ' widgets ', campaign: 'launch' });
    setCookie('b4m_last_touch', { source: 'email', medium: 'newsletter' });

    expect(attributionParams('purchase')).toEqual({
      first_touch_source: 'widgets',
      first_touch_campaign: 'launch',
      utm_source_at_purchase: 'email',
      utm_medium_at_purchase: 'newsletter',
    });
    const server = readAcquisitionTouches({ headers: { cookie: document.cookie } });
    expect(attributionParams('signup').first_touch_source).toBe(server.firstTouch?.source);
    expect(attributionParams('signup').utm_source_at_signup).toBe(server.lastTouch?.source);
  });

  it('prefers marketing first touch and persistent last touch over the fallbacks', () => {
    setCookie('b4m-first-touch', { source: 'search' });
    setCookie('b4m_app_first_touch', { source: 'widgets' });
    setCookie('b4m_last_touch', { source: 'newsletter' });
    setCookie('b4m_utm', { source: 'session' });
    expect(attributionParams('purchase')).toEqual({
      first_touch_source: 'search',
      utm_source_at_purchase: 'newsletter',
    });
  });

  it.each([null, [], {}, { medium: 'email' }, { source: ' ' }, { source: 12 }])(
    'falls back from an invalid marketing touch (%j)',
    value => {
      setCookie('b4m-first-touch', value);
      setCookie('b4m_app_first_touch', { source: 'widgets' });
      expect(attributionParams('signup').first_touch_source).toBe('widgets');
    }
  );

  it('ignores malformed JSON and percent encoding and applies field caps', () => {
    document.cookie = 'b4m-first-touch=%; path=/';
    document.cookie = 'b4m_last_touch=not-json; path=/';
    setCookie('b4m_app_first_touch', { source: 'x'.repeat(300), medium: 1 });
    setCookie('b4m_utm', { source: 'fallback' });
    expect(attributionParams('purchase')).toEqual({
      first_touch_source: 'x'.repeat(128),
      utm_source_at_purchase: 'fallback',
    });
  });

  it.each(['denied', 'unset'])('does not use a surviving marketing cookie when consent is %s', consent => {
    setCookie('b4m-first-touch', { source: 'widgets' });
    localStorage.setItem('cookie_consent', consent);
    clearAttributionCookies();
    expect(document.cookie).toContain('b4m-first-touch=');
    expect(attributionParams('purchase')).toEqual({});
  });
});

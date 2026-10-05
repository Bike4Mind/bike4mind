import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureUtmParams, flushUtmCapture } from './utmCapture';

function readUtmCookie(): Record<string, string> | null {
  const match = document.cookie.split('; ').find(c => c.startsWith('b4m_utm='));
  if (!match) return null;
  return JSON.parse(decodeURIComponent(match.slice('b4m_utm='.length)));
}

function setSearch(search: string) {
  // jsdom allows replacing location.search via history.replaceState
  window.history.replaceState({}, '', `/${search}`);
}

function clearUtmCookie() {
  for (const name of ['b4m_utm', 'b4m_last_touch', 'b4m_app_first_touch', 'b4m-region', 'b4m-consent-decision']) {
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
  try {
    localStorage.removeItem('cookie_consent');
  } catch {
    // ignore storage errors
  }
}

// These cookies are non-essential, so nothing is written until consent allows it. Most tests
// here are about what gets captured, not about the gate, so they run as a consenting visitor.
function grantConsent() {
  localStorage.setItem('cookie_consent', 'granted');
}

function readCookie(name: string): Record<string, string> | null {
  const match = document.cookie.split('; ').find(c => c.startsWith(`${name}=`));
  return match ? JSON.parse(decodeURIComponent(match.slice(name.length + 1))) : null;
}

describe('captureUtmParams', () => {
  beforeEach(() => {
    clearUtmCookie();
    setSearch('');
    grantConsent();
  });
  afterEach(() => {
    clearUtmCookie();
    vi.restoreAllMocks();
  });

  it('writes nothing when utm_source is absent', () => {
    setSearch('?foo=bar&utm_medium=email');
    captureUtmParams();
    expect(readUtmCookie()).toBeNull();
  });

  it('captures source only when just utm_source is present', () => {
    setSearch('?utm_source=newsletter');
    captureUtmParams();
    expect(readUtmCookie()).toEqual({ source: 'newsletter' });
  });

  it('captures source, medium, campaign, and content when all present', () => {
    setSearch('?utm_source=email&utm_medium=newsletter&utm_campaign=launch&utm_content=cta');
    captureUtmParams();
    expect(readUtmCookie()).toEqual({
      source: 'email',
      medium: 'newsletter',
      campaign: 'launch',
      content: 'cta',
    });
  });

  it('omits absent optional params', () => {
    setSearch('?utm_source=email&utm_campaign=launch');
    captureUtmParams();
    expect(readUtmCookie()).toEqual({ source: 'email', campaign: 'launch' });
  });

  it('writes a SameSite=Strict, path=/ cookie', () => {
    const setSpy = vi.spyOn(document, 'cookie', 'set');
    setSearch('?utm_source=email');
    captureUtmParams();
    const written = setSpy.mock.calls[0][0];
    expect(written).toContain('b4m_utm=');
    expect(written).toContain('path=/');
    expect(written).toContain('SameSite=Strict');
    expect(written).toContain('expires=');
  });

  describe('purchase-attribution touches', () => {
    it('keeps the latest campaign as the last touch and the first one as the app first touch', () => {
      setSearch('?utm_source=first&utm_medium=email');
      captureUtmParams();
      setSearch('?utm_source=second&utm_medium=social');
      captureUtmParams();
      expect(readCookie('b4m_last_touch')).toEqual({ source: 'second', medium: 'social' });
      expect(readCookie('b4m_app_first_touch')).toEqual({ source: 'first', medium: 'email' });
    });

    it('writes neither without a utm_source', () => {
      setSearch('?utm_medium=email');
      captureUtmParams();
      expect(readCookie('b4m_last_touch')).toBeNull();
      expect(readCookie('b4m_app_first_touch')).toBeNull();
    });
  });

  describe('consent gate', () => {
    const ALL = ['b4m_utm', 'b4m_last_touch', 'b4m_app_first_touch'] as const;
    const expectNothingWritten = () => ALL.forEach(name => expect(readCookie(name)).toBeNull());

    beforeEach(() => {
      // A capture held but never flushed outlives the test that made it (it is module
      // scope, one page load). Drain it under consent, then clear what that wrote, so a
      // leftover cannot be mistaken for something this test captured.
      localStorage.setItem('cookie_consent', 'granted');
      flushUtmCapture();
      clearUtmCookie();
      setSearch('');
    });

    it('writes nothing for an opt-in-region visitor who has not answered yet', () => {
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      expectNothingWritten();
    });

    it('writes nothing for a visitor who declined here', () => {
      document.cookie = 'b4m-region=row; path=/';
      localStorage.setItem('cookie_consent', 'denied');
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      expectNothingWritten();
    });

    it('writes nothing for a visitor who declined on the marketing site', () => {
      document.cookie = 'b4m-region=row; path=/';
      document.cookie = 'b4m-consent-decision=denied; path=/';
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      expectNothingWritten();
    });

    it('writes straight away outside the opt-in region, where consent is granted by default', () => {
      document.cookie = 'b4m-region=row; path=/';
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      expect(readCookie('b4m_last_touch')).toEqual({ source: 'newsletter' });
    });

    it('honours a decision made on the marketing site without asking again', () => {
      document.cookie = 'b4m-consent-decision=granted; path=/';
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      expect(readCookie('b4m_last_touch')).toEqual({ source: 'newsletter' });
    });

    it('still attributes a visitor who accepts after landing, once the query string is gone', () => {
      setSearch('?utm_source=newsletter&utm_campaign=launch');
      captureUtmParams();
      expectNothingWritten();

      // What the route guard does to an unauthenticated landing before the banner can be
      // answered: the campaign is no longer readable from the URL.
      setSearch('');
      localStorage.setItem('cookie_consent', 'granted');
      flushUtmCapture();

      expect(readCookie('b4m_last_touch')).toEqual({ source: 'newsletter', campaign: 'launch' });
      expect(readCookie('b4m_app_first_touch')).toEqual({ source: 'newsletter', campaign: 'launch' });
    });

    it('writes nothing on a flush that consent still does not allow', () => {
      setSearch('?utm_source=newsletter');
      captureUtmParams();
      flushUtmCapture();
      expectNothingWritten();
    });

    it('writes nothing on a flush when there was no campaign to capture', () => {
      setSearch('?foo=bar');
      captureUtmParams();
      localStorage.setItem('cookie_consent', 'granted');
      flushUtmCapture();
      expectNothingWritten();
    });
  });
});

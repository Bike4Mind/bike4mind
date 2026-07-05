import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { captureUtmParams } from './utmCapture';

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
  document.cookie = 'b4m_utm=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

describe('captureUtmParams', () => {
  beforeEach(() => {
    clearUtmCookie();
    setSearch('');
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
});

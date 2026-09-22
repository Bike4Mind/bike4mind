import { describe, it, expect, afterEach } from 'vitest';
import { readConsentRegion, REGION_COOKIE } from './consentRegion';

function setCookie(raw: string) {
  document.cookie = raw;
}

function clearCookies() {
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) document.cookie = `${name}=; max-age=0`;
  }
}

describe('readConsentRegion', () => {
  afterEach(clearCookies);

  it("returns 'row' for the explicit auto-allow value", () => {
    setCookie(`${REGION_COOKIE}=row`);
    expect(readConsentRegion()).toBe('row');
  });

  it("returns 'eu' for the opt-in value", () => {
    setCookie(`${REGION_COOKIE}=eu`);
    expect(readConsentRegion()).toBe('eu');
  });

  // The fail-safe direction: a fork, a direct arrival, or a visitor whose
  // marketing-site hop never happened must be asked, not assumed.
  it("falls back to 'eu' when the cookie is absent", () => {
    expect(readConsentRegion()).toBe('eu');
  });

  it("falls back to 'eu' for an unrecognized value", () => {
    setCookie(`${REGION_COOKIE}=somewhere-else`);
    expect(readConsentRegion()).toBe('eu');
  });

  // A prefix match would read 'b4m-region-override=row' as the real cookie.
  it('does not match a different cookie whose name starts the same way', () => {
    setCookie(`${REGION_COOKIE}-override=row`);
    expect(readConsentRegion()).toBe('eu');
  });

  it('reads the cookie when other cookies sit in front of it', () => {
    setCookie('b4m_utm=%7B%7D');
    setCookie(`${REGION_COOKIE}=row`);
    expect(readConsentRegion()).toBe('row');
  });
});

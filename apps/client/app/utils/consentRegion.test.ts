import { describe, it, expect, afterEach, vi } from 'vitest';
import { APP_DECISION_COOKIE, DECISION_COOKIE, REGION_COOKIE } from '@client/lib/consentCookies';
import { readConsentRegion, readSharedConsent, publishResolvedConsent } from './consentRegion';

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

  // A fork, or a visitor whose marketing-site hop never happened, must be asked.
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

describe('readSharedConsent', () => {
  afterEach(clearCookies);

  it('reads a decline made on the marketing site', () => {
    setCookie(`${DECISION_COOKIE}=denied`);
    expect(readSharedConsent()).toBe('denied');
  });

  it('reads an acceptance made on the marketing site', () => {
    setCookie(`${DECISION_COOKIE}=granted`);
    expect(readSharedConsent()).toBe('granted');
  });

  it('returns null when no decision has been published', () => {
    expect(readSharedConsent()).toBeNull();
  });

  // A truncated or tampered value must fall through to the region, never read as consent.
  it('returns null for an unrecognized value', () => {
    setCookie(`${DECISION_COOKIE}=grante`);
    expect(readSharedConsent()).toBeNull();
  });

  it('does not match a different cookie whose name starts the same way', () => {
    setCookie(`${DECISION_COOKIE}-test=granted`);
    expect(readSharedConsent()).toBeNull();
  });

  it('is independent of the region cookie', () => {
    setCookie(`${REGION_COOKIE}=row`);
    setCookie(`${DECISION_COOKIE}=denied`);
    expect(readConsentRegion()).toBe('row');
    expect(readSharedConsent()).toBe('denied');
  });
});

describe('publishResolvedConsent', () => {
  afterEach(clearCookies);

  const published = () =>
    document.cookie
      .split('; ')
      .find(c => c.startsWith(`${APP_DECISION_COOKIE}=`))
      ?.slice(APP_DECISION_COOKIE.length + 1);

  // The server cannot read this origin's localStorage decision, so the banner hands it the
  // resolution instead. Both values matter: 'denied' is what stops a stale marketing grant
  // attributing a visitor who declined here.
  it.each(['granted', 'denied'] as const)('publishes %s where the server can read it', value => {
    publishResolvedConsent(value);
    expect(published()).toBe(value);
  });

  // The counterweight to publishing an auto-allow: a visitor who carries one into the opt-in
  // region resolves to 'unset' on the next load, and must stop being attributed at that point
  // rather than keeping a 90-day grant they never gave.
  it('withdraws a previously published decision on unset', () => {
    publishResolvedConsent('granted');
    expect(published()).toBe('granted');

    publishResolvedConsent('unset');
    expect(published()).toBeUndefined();
  });

  // Load-bearing, not cosmetic: the OAuth callback reads this cookie on a top-level cross-site
  // GET from the IdP, and SameSite=Strict is withheld on exactly that navigation. Under Strict
  // every app-direct consented OAuth signup is suppressed, and the callback tests cannot see it
  // because they inject the cookie straight into the request headers - so it fails here.
  it.each(['granted', 'denied', 'unset'] as const)('writes %s as a SameSite=Lax, path=/ cookie', value => {
    const setSpy = vi.spyOn(document, 'cookie', 'set');
    try {
      publishResolvedConsent(value);
      const written = setSpy.mock.calls.map(([v]) => v as string).find(v => v.startsWith(`${APP_DECISION_COOKIE}=`));
      expect(written).toBeDefined();
      expect(written).toContain('path=/');
      expect(written).toContain('SameSite=Lax');
      expect(written).not.toContain('SameSite=Strict');
      // A decision is kept for 90 days and a withdrawal expires it now; without expires= either
      // becomes a session cookie that disappears when the browser closes.
      expect(written).toContain('expires=');
    } finally {
      setSpy.mockRestore();
    }
  });

  it('leaves the marketing site and region cookies alone', () => {
    setCookie(`${DECISION_COOKIE}=denied`);
    setCookie(`${REGION_COOKIE}=eu`);

    publishResolvedConsent('granted');

    expect(readSharedConsent()).toBe('denied');
    expect(readConsentRegion()).toBe('eu');
  });
});

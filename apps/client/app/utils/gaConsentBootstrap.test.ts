import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gaBootstrapScript } from './gaConsentBootstrap';
import { DECISION_COOKIE, REGION_COOKIE } from '@client/lib/consentCookies';
import { CONSENT_KEY, resolveConsent } from './consentRegion';

function clearCookies() {
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) document.cookie = `${name}=; max-age=0`;
  }
}

/** Runs the inline tag as the page would, and returns the gtag commands it queued. */
function runScript(measurementId = 'G-TEST', cookieDomain?: string): unknown[][] {
  const w = window as unknown as { dataLayer?: IArguments[] };
  delete w.dataLayer;
  new Function(gaBootstrapScript(measurementId, cookieDomain))();
  return (w.dataLayer ?? []).map(args => Array.from(args));
}

const consentDefault = (commands: unknown[][]) =>
  (commands.find(c => c[0] === 'consent' && c[1] === 'default')?.[2] as { analytics_storage: string })
    .analytics_storage;

describe('gaBootstrapScript', () => {
  beforeEach(() => {
    localStorage.clear();
    clearCookies();
    delete window.__b4mGaConsentDefault;
  });
  afterEach(() => vi.restoreAllMocks());

  // Every combination of the three signals, including values neither side should accept.
  const stored = [null, 'granted', 'denied', 'maybe'];
  const shared = [null, 'granted', 'denied', 'maybe'];
  const region = [null, 'row', 'eu', 'somewhere-else'];
  const cases = stored.flatMap(s => shared.flatMap(d => region.map(r => [s, d, r] as const)));

  it.each(cases)('agrees with resolveConsent() for stored=%s shared=%s region=%s', (s, d, r) => {
    if (s) localStorage.setItem(CONSENT_KEY, s);
    if (d) document.cookie = `${DECISION_COOKIE}=${d}`;
    if (r) document.cookie = `${REGION_COOKIE}=${r}`;

    const expected = resolveConsent() === 'granted' ? 'granted' : 'denied';
    expect(consentDefault(runScript())).toBe(expected);
    expect(window.__b4mGaConsentDefault).toBe(expected);
  });

  // resolveConsent() treats unreadable storage as "no decision here" and moves on.
  it('falls through to the shared decision when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    document.cookie = `${DECISION_COOKIE}=granted`;
    expect(resolveConsent()).toBe('granted');
    expect(consentDefault(runScript())).toBe('granted');
  });

  it('does not read a longer cookie name as the real one', () => {
    document.cookie = `${REGION_COOKIE}-override=row`;
    expect(consentDefault(runScript())).toBe('denied');
  });

  // The whole point: the landing page_view is sent by config, so the default must precede it.
  it('sets the consent default before config sends the page_view', () => {
    const commands = runScript('G-ABC123');
    const names = commands.map(c => c[0]);
    expect(names).toEqual(['consent', 'js', 'config']);
    expect(commands[2]).toEqual(['config', 'G-ABC123']);
  });

  it('passes the cookie domain to config when one is pinned', () => {
    expect(runScript('G-ABC123', 'bike4mind.com')[2]).toEqual([
      'config',
      'G-ABC123',
      { cookie_domain: 'bike4mind.com' },
    ]);
  });
});

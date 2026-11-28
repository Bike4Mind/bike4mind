import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { gaBootstrapScript, getGaMeasurementIds } from './gaConsentBootstrap';
import { DECISION_COOKIE, REGION_COOKIE } from '@bike4mind/server-utils/lib/consentCookies';
import { CONSENT_KEY, resolveConsent } from './consentRegion';

function clearCookies() {
  for (const entry of document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) document.cookie = `${name}=; max-age=0`;
  }
}

/** Runs the inline tag as the page would, and returns the gtag commands it queued. */
function runScript(measurementIds: readonly string[] = ['G-TEST'], cookieDomain?: string): unknown[][] {
  const w = window as unknown as { dataLayer?: IArguments[] };
  delete w.dataLayer;
  new Function(gaBootstrapScript(measurementIds, cookieDomain))();
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
    const commands = runScript(['G-ABC123']);
    const names = commands.map(c => c[0]);
    expect(names).toEqual(['consent', 'js', 'set', 'config']);
    expect(commands[3]).toEqual(['config', 'G-ABC123']);
  });

  it('passes the cookie domain to config when one is pinned', () => {
    expect(runScript(['G-ABC123'], 'bike4mind.com')[3]).toEqual([
      'config',
      'G-ABC123',
      { cookie_domain: 'bike4mind.com' },
    ]);
  });

  // The marketing site's property sees the funnel only if its config also comes after the
  // consent default, and only one client id exists if both write the same cookie.
  it('configures every property after the consent default, each with the pinned cookie domain', () => {
    const commands = runScript(['G-APP0000001', 'G-SITE000001'], 'bike4mind.com');
    expect(commands.map(c => c[0])).toEqual(['consent', 'js', 'set', 'config', 'config']);
    expect(commands.slice(3)).toEqual([
      ['config', 'G-APP0000001', { cookie_domain: 'bike4mind.com' }],
      ['config', 'G-SITE000001', { cookie_domain: 'bike4mind.com' }],
    ]);
  });

  it('configures every property without a cookie domain when none is pinned', () => {
    expect(runScript(['G-APP0000001', 'G-SITE000001']).slice(3)).toEqual([
      ['config', 'G-APP0000001'],
      ['config', 'G-SITE000001'],
    ]);
  });
});

describe('gaBootstrapScript page_location', () => {
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  const pageLocations = () =>
    ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? [])
      .map(args => Array.from(args))
      .filter(c => c[0] === 'set')
      .map(c => (c[1] as { page_location: string }).page_location);

  afterEach(() => {
    history.pushState = pushState;
    history.replaceState = replaceState;
    history.replaceState(null, '', '/');
  });

  it('records the landing page without its fragment, before config sends the page_view', () => {
    history.replaceState(null, '', '/x/shared?ref=a#secret-token');
    const commands = runScript(['G-ABC123']);

    expect(commands.findIndex(c => c[0] === 'set')).toBeLessThan(commands.findIndex(c => c[0] === 'config'));
    expect(pageLocations()).toEqual([`${window.location.origin}/x/shared?ref=a`]);
    expect(window.location.hash).toBe('#secret-token');
  });

  it('keeps the fragment out after in-app navigation, back/forward and fragment changes', () => {
    runScript(['G-ABC123']);
    const latest = () => pageLocations().at(-1);

    history.pushState(null, '', '/x/shared#token-b');
    expect(latest()).toBe(`${window.location.origin}/x/shared`);
    history.replaceState(null, '', '/other?q=1#token-c');
    expect(latest()).toBe(`${window.location.origin}/other?q=1`);
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(latest()).toBe(`${window.location.origin}/other?q=1`);
    expect(pageLocations().every(location => !location.includes('#'))).toBe(true);
  });
});

describe('getGaMeasurementIds', () => {
  afterEach(() => vi.unstubAllEnvs());

  const ids = (app: string, marketing?: string) => {
    vi.stubEnv('NEXT_PUBLIC_GA_MEASUREMENT_ID', app);
    if (marketing !== undefined) vi.stubEnv('NEXT_PUBLIC_GA_MARKETING_MEASUREMENT_ID', marketing);
    return getGaMeasurementIds();
  };

  it('is the app property alone when no marketing property is set', () => {
    expect(ids('G-APP0000001')).toEqual(['G-APP0000001']);
    expect(ids('G-APP0000001', '')).toEqual(['G-APP0000001']);
  });

  it('adds the marketing property after the app property', () => {
    expect(ids('G-APP0000001', 'G-SITE000001')).toEqual(['G-APP0000001', 'G-SITE000001']);
  });

  // GA_MEASUREMENT_ID is the one switch: emptying it turns GA off even with a marketing id set.
  it('is empty without the app property, whatever the marketing property says', () => {
    expect(ids('', 'G-SITE000001')).toEqual([]);
  });

  // A second config for the same property would send every landing page_view twice.
  it('names a property once when both values are the same', () => {
    expect(ids('G-APP0000001', 'G-APP0000001')).toEqual(['G-APP0000001']);
  });

  // A pasted variable can carry a trailing newline, and gtag would not match the padded id.
  it('ignores whitespace around either id and reads a blank one as unset', () => {
    expect(ids(' G-APP0000001\n', '  G-SITE000001 ')).toEqual(['G-APP0000001', 'G-SITE000001']);
    expect(ids('G-APP0000001', '   ')).toEqual(['G-APP0000001']);
    expect(ids('  ', 'G-SITE000001')).toEqual([]);
  });
});

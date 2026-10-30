import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { mockResolveConsent } = vi.hoisted(() => ({ mockResolveConsent: vi.fn() }));
vi.mock('../consentRegion', () => ({ resolveConsent: mockResolveConsent }));

import { beaconVisit } from '../visitBeacon';

const setReferrer = (value: string) => Object.defineProperty(document, 'referrer', { value, configurable: true });

beforeEach(() => {
  mockResolveConsent.mockReturnValue('granted');
  setReferrer('');
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

const sentBody = (fetchMock: ReturnType<typeof vi.fn>) =>
  JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as Record<string, unknown>;

describe('beaconVisit', () => {
  it('posts to the beacon with the cookies and a keepalive request', () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    beaconVisit();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/analytics/visit');
    expect(init.method).toBe('POST');
    // Both of these are the mechanism, not hygiene: without credentials the server cannot
    // tell a returning browser from a new visit, and without keepalive the request is
    // cancelled by the redirect an unauthenticated landing performs immediately after.
    expect(init.credentials).toBe('same-origin');
    expect(init.keepalive).toBe(true);
  });

  it('sends the referring site as its origin and the landing path, with consent', () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    setReferrer('https://www.google.com/search?q=private+words');
    window.history.replaceState(null, '', '/pricing?ref=mail');

    beaconVisit();

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    // The page's own path only: the query never leaves it, nor the referrer's path or query.
    expect(sentBody(fetchMock)).toEqual({ referrer: 'https://www.google.com', landingPath: '/pricing' });
  });

  it('sends the landing path alone when there is no referrer', () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);

    beaconVisit();

    expect(sentBody(fetchMock)).toEqual({ landingPath: '/' });
  });

  it('cuts an over-long landing path at a segment boundary, never inside a token', () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState(null, '', `/${'page-'.repeat(38)}/aB3dE5fG7hJ9kL1mN3pQ`);

    beaconVisit();

    expect(sentBody(fetchMock).landingPath).toBe(`/${'page-'.repeat(38)}`);
  });

  it('sends neither without consent, as the campaign capture waits for it', () => {
    for (const state of ['denied', 'unset']) {
      mockResolveConsent.mockReturnValue(state);
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      setReferrer('https://www.google.com/');

      beaconVisit();

      expect(sentBody(fetchMock), state).toEqual({});
    }
  });

  it('swallows a rejected beacon rather than surfacing it to the visitor', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);

    expect(() => beaconVisit()).not.toThrow();
    // Let the rejection settle: an unhandled one would fail this test run.
    await Promise.resolve();
  });

  it('does nothing where fetch does not exist', () => {
    vi.stubGlobal('fetch', undefined);
    expect(() => beaconVisit()).not.toThrow();
  });
});

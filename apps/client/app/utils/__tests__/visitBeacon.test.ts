import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { mockResolveConsent } = vi.hoisted(() => ({ mockResolveConsent: vi.fn() }));
vi.mock('../consentRegion', () => ({ resolveConsent: mockResolveConsent }));

import { beaconVisit, releaseVisitBeacon } from '../visitBeacon';

const setReferrer = (value: string) => Object.defineProperty(document, 'referrer', { value, configurable: true });
const setVisibility = (value: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });

beforeEach(() => {
  // Drop a beacon an earlier case left waiting: the held landing is module state.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 204 }));
  releaseVisitBeacon();
  mockResolveConsent.mockReturnValue('granted');
  setReferrer('');
  setVisibility('visible');
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

const sentBody = (fetchMock: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse((fetchMock.mock.calls[call] as [string, RequestInit])[1].body as string) as Record<string, unknown>;

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

  it('sends neither once consent is declined', () => {
    mockResolveConsent.mockReturnValue('denied');
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    setReferrer('https://www.google.com/');

    beaconVisit();

    expect(sentBody(fetchMock)).toEqual({});
  });

  describe('while the visitor is still being asked for consent', () => {
    beforeEach(() => {
      mockResolveConsent.mockReturnValue('unset');
      setReferrer('https://www.google.com/search?q=private+words');
      window.history.replaceState(null, '', '/pricing');
    });

    it('says the visit awaits consent and sends no source yet', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);

      beaconVisit();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sentBody(fetchMock)).toEqual({ awaitingConsent: true });
    });

    it('sends the held source once consent is granted, with the page it landed on', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();
      // The router has redirected the signed-out landing by the time the visitor answers.
      window.history.replaceState(null, '', '/login');
      mockResolveConsent.mockReturnValue('granted');

      releaseVisitBeacon();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentBody(fetchMock, 1)).toEqual({ referrer: 'https://www.google.com', landingPath: '/pricing' });
      const init = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
      expect(init.keepalive).toBe(true);
      expect(init.credentials).toBe('same-origin');
    });

    it('records the visit with no source when consent is declined', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();
      mockResolveConsent.mockReturnValue('denied');

      releaseVisitBeacon();

      expect(sentBody(fetchMock, 1)).toEqual({});
    });

    it('records the visit with no source when the page is hidden before an answer', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();

      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentBody(fetchMock, 1)).toEqual({});
    });

    it('records the visit with no source when the page is unloaded before an answer', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();

      window.dispatchEvent(new Event('pagehide'));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sentBody(fetchMock, 1)).toEqual({});
    });

    it('records the visit once, whatever follows the first release', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();
      mockResolveConsent.mockReturnValue('granted');

      releaseVisitBeacon();
      releaseVisitBeacon();
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ignores a tab that is shown again, not hidden', () => {
      const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
      vi.stubGlobal('fetch', fetchMock);
      beaconVisit();

      document.dispatchEvent(new Event('visibilitychange'));

      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });

  it('releases nothing when no beacon is waiting', () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    beaconVisit();

    releaseVisitBeacon();

    expect(fetchMock).toHaveBeenCalledOnce();
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

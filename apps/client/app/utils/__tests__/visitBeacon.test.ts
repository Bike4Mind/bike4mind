import { describe, it, expect, vi, afterEach } from 'vitest';
import { beaconVisit } from '../visitBeacon';

afterEach(() => vi.unstubAllGlobals());

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

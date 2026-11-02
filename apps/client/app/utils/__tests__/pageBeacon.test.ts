import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const { mockResolveConsent } = vi.hoisted(() => ({ mockResolveConsent: vi.fn() }));
vi.mock('../consentRegion', () => ({ resolveConsent: mockResolveConsent }));

import { beaconPage, startPageBeacon } from '../pageBeacon';
import { beaconVisit } from '../visitBeacon';

const PAGE_BEACON = '/api/analytics/page';

/** The page beacon sends after the visit beacon's request settles, so let that chain run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const goTo = (path: string) => window.history.replaceState(null, '', path);

let fetchMock: ReturnType<typeof vi.fn>;

const pageCalls = () => fetchMock.mock.calls.filter(([url]) => url === PAGE_BEACON) as [string, RequestInit][];
const sentPaths = () => pageCalls().map(([, init]) => (JSON.parse(init.body as string) as { path: string }).path);

/** A page load landing on `path`, then the router settling on each of `pages` in turn. */
async function land(path: string, ...pages: string[]) {
  goTo(path);
  startPageBeacon();
  for (const page of pages) {
    goTo(page);
    beaconPage();
  }
  await settle();
}

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ status: 204 });
  vi.stubGlobal('fetch', fetchMock);
  mockResolveConsent.mockReturnValue('granted');
});
afterEach(() => {
  vi.unstubAllGlobals();
  goTo('/');
});

describe('beaconPage', () => {
  it('sends nothing for the landing itself, which the visit already carries', async () => {
    // The router's first resolve lands on the page the load started on.
    await land('/pricing', '/pricing');

    expect(pageCalls()).toHaveLength(0);
  });

  it('posts a later page with the cookies and a keepalive request', async () => {
    await land('/pricing', '/notebooks');

    expect(pageCalls()).toHaveLength(1);
    const [, init] = pageCalls()[0];
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    // The visit cookie ties the page to its visit; keepalive lets it survive a click away.
    expect(init.credentials).toBe('same-origin');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toEqual({ path: '/notebooks' });
  });

  it('sends the path alone, never the query or the hash', async () => {
    await land('/', '/search?q=private+words#results');

    expect(sentPaths()).toEqual(['/search']);
  });

  it('records the page a signed-out landing is redirected to', async () => {
    await land('/pricing', '/login');

    expect(sentPaths()).toEqual(['/login']);
  });

  it('skips query- and hash-only changes', async () => {
    await land('/', '/notebooks', '/notebooks?tab=recent', '/notebooks#top', '/notebooks?tab=all#x');

    expect(sentPaths()).toEqual(['/notebooks']);
  });

  it('skips a repeat of the last path sent, but sends a return to an earlier page', async () => {
    await land('/', '/a', '/a', '/b', '/a', '/');

    expect(sentPaths()).toEqual(['/a', '/b', '/a', '/']);
  });

  it('cuts an over-long path at a segment boundary, never inside a token', async () => {
    await land('/', `/${'page-'.repeat(38)}/aB3dE5fG7hJ9kL1mN3pQ`);

    expect(sentPaths()).toEqual([`/${'page-'.repeat(38)}`]);
  });

  it('sends nothing once consent is declined', async () => {
    mockResolveConsent.mockReturnValue('denied');

    await land('/', '/a', '/b');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing while consent is not yet given, and holds none of those pages for later', async () => {
    mockResolveConsent.mockReturnValue('unset');
    await land('/pricing', '/login', '/register');
    expect(fetchMock).not.toHaveBeenCalled();

    // The banner calls beaconPage() on a grant: only the page the visitor is on now is sent.
    mockResolveConsent.mockReturnValue('granted');
    beaconPage();
    await settle();

    expect(sentPaths()).toEqual(['/register']);
  });

  it('stops after 100 pages in one page load, and starts again with the next load', async () => {
    const pages = Array.from({ length: 150 }, (_, i) => `/p${i}`);
    await land('/', ...pages);

    expect(pageCalls()).toHaveLength(100);
    expect(sentPaths().at(-1)).toBe('/p99');

    await land('/', '/after-reload');
    expect(sentPaths().at(-1)).toBe('/after-reload');
  });

  it('waits for the visit beacon, so the request carries the cookie its response sets', async () => {
    let answerVisit: (value: unknown) => void = () => {};
    fetchMock.mockImplementation((url: string) =>
      url === PAGE_BEACON ? Promise.resolve({ status: 204 }) : new Promise(resolve => (answerVisit = resolve))
    );
    goTo('/pricing');
    beaconVisit();
    startPageBeacon();
    goTo('/login');
    beaconPage();
    await settle();

    expect(pageCalls()).toHaveLength(0);

    answerVisit({ status: 204 });
    await settle();

    expect(sentPaths()).toEqual(['/login']);
  });

  it('still sends after a visit beacon that failed', async () => {
    fetchMock.mockImplementation((url: string) =>
      url === PAGE_BEACON ? Promise.resolve({ status: 204 }) : Promise.reject(new Error('offline'))
    );
    goTo('/pricing');
    beaconVisit();

    await land('/pricing', '/login');

    expect(sentPaths()).toEqual(['/login']);
  });

  it('swallows a rejected request rather than surfacing it to the visitor', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));

    // An unhandled rejection here would fail the run.
    await land('/', '/a');

    expect(pageCalls()).toHaveLength(1);
  });

  it('does nothing where fetch does not exist', async () => {
    goTo('/');
    startPageBeacon();
    vi.stubGlobal('fetch', undefined);
    goTo('/a');

    expect(() => beaconPage()).not.toThrow();
    await settle();
  });

  it('does nothing before the landing is known', async () => {
    vi.resetModules();
    const fresh = await import('../pageBeacon');
    goTo('/a');

    fresh.beaconPage();
    await settle();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

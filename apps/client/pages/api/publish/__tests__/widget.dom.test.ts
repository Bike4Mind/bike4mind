// @vitest-environment jsdom
//
// EXECUTION coverage for the comment-overlay widget's CREDENTIAL path.
//
// widget.test.ts already drives the shipped script in jsdom, but it stubs `can-comment` to
// return `canComment` directly, so nothing ever exercised how the widget obtains a token -
// which is why #1811 went unnoticed: the widget read an access token out of localStorage,
// #1346 made that field permanently undefined, and no test could tell. These cover the
// acquisition itself, in the same shape as renderBundleLoaderShell.dom.test.ts.
//
// The other half of the bug was cost-shaped rather than correctness-shaped, so the traffic
// assertions below are load-bearing too: an anonymous reader of a public artifact must issue
// ZERO requests to /api/auth/refreshToken, which is rate-limited per IP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../widget';

/** Render the widget exactly as the route serves it. */
function widgetSource(): string {
  let body = '';
  const res = {
    setHeader: () => res,
    status: () => res,
    send: (b: string) => {
      body = b;
      return res;
    },
  } as never;
  handler({} as never, res);
  if (!body) throw new Error('widget handler produced no body');
  return body;
}

interface StubbedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: StubbedCall[] = [];

const REFRESH = '/api/auth/refreshToken';
const CAN_COMMENT = 'can-comment';

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(''),
    headers: { get: () => null },
  } as unknown as Response;
}

/**
 * Route fetches by URL. `listStatus` lets a test describe a gated artifact (401 until a
 * credential is presented) versus a public one.
 */
function stubFetch(opts: { signedIn: boolean; gated?: boolean }) {
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const authed = !!(init?.headers as Record<string, string> | undefined)?.Authorization;

    if (url.includes(REFRESH)) {
      return Promise.resolve(opts.signedIn ? res(200, { accessToken: 'fresh.token' }) : res(401, {}));
    }
    if (url.includes(CAN_COMMENT)) {
      return Promise.resolve(
        authed
          ? res(200, { commentPolicy: 'open', canComment: true })
          : res(200, { commentPolicy: 'open', canComment: false })
      );
    }
    // the annotations list
    if (opts.gated && !authed) return Promise.resolve(res(401, { error: 'Authentication required' }));
    return Promise.resolve(
      res(200, {
        commentPolicy: 'open',
        annotations: [{ id: 'c1', authorDisplayName: 'Ada', body: 'first', createdAt: new Date(0).toISOString() }],
      })
    );
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

function mountWidget(): void {
  document.body.innerHTML =
    '<div id="b4m-annotate-root" data-public-id="pub_1" data-comment-policy="open" data-title="T"></div><iframe></iframe>';
}

/** Run the widget and let its promise chain settle. */
async function runWidget(): Promise<void> {
  // eval, deliberately: executing the REAL shipped script is the whole point - a test that
  // reimplemented the credential logic would have passed straight through #1811.
  eval(widgetSource());
  await vi.advanceTimersByTimeAsync(0);
}

function refreshCalls(): StubbedCall[] {
  return calls.filter(c => c.url.includes(REFRESH));
}

function clickLauncher(): void {
  (document.getElementById('b4m-launch') as HTMLButtonElement).click();
}

describe('publish comment widget - credential path', () => {
  beforeEach(() => {
    calls = [];
    vi.useFakeTimers();
    mountWidget();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('never reads a credential from localStorage', async () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    stubFetch({ signedIn: true });

    await runWidget();
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);

    expect(getItem).not.toHaveBeenCalled();
  });

  it('costs an anonymous reader of a public artifact ZERO auth requests', async () => {
    // The rate-limit protection: this is the overwhelmingly common path, and it must not
    // touch /api/auth/refreshToken at all when the panel is never opened.
    stubFetch({ signedIn: false });

    await runWidget();
    await vi.advanceTimersByTimeAsync(120000); // two poll cycles

    expect(refreshCalls()).toHaveLength(0);
    // The comment list still loads and renders anonymously.
    expect(document.getElementById('b4m-launch')?.textContent).toContain('1');
  });

  it('shows the composer to a signed-in viewer once the panel is opened', async () => {
    stubFetch({ signedIn: true });

    await runWidget();
    expect(refreshCalls()).toHaveLength(0); // still nothing before interaction

    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls()).toHaveLength(1);
    expect(document.getElementById('b4m-ta')).not.toBeNull(); // composer textarea
    expect(document.getElementById('b4m-signin')).toBeNull(); // NOT "Sign in to comment"
  });

  it('still shows the sign-in prompt to a genuinely signed-out viewer', async () => {
    stubFetch({ signedIn: false });

    await runWidget();
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.getElementById('b4m-signin')).not.toBeNull();
    expect(document.getElementById('b4m-ta')).toBeNull();
  });

  it('makes existing comments on a gated artifact visible to an authorized reader', async () => {
    // The list 401s unauthenticated; the widget must discover that, obtain a credential and
    // retry, rather than swallowing it and rendering "No comments yet".
    stubFetch({ signedIn: true, gated: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(0);

    expect(refreshCalls()).toHaveLength(1);
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('b4m-list')?.textContent).toContain('first');
    expect(document.getElementById('b4m-list')?.textContent).not.toContain('No comments yet');
  });

  it('attempts the exchange only once for a signed-out viewer of a gated artifact', async () => {
    // The negative result is cached, so 60s polls cannot turn into a stream of exchanges.
    stubFetch({ signedIn: false, gated: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(180000); // three poll cycles

    expect(refreshCalls()).toHaveLength(1);
  });

  it('recovers a session that expires while the page is open', async () => {
    // A page can outlive the 30-minute access-token TTL many times over.
    let tokenGeneration = 0;
    let listSeenStale = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (url.includes(REFRESH)) {
          tokenGeneration++;
          return Promise.resolve(res(200, { accessToken: 'token.gen' + tokenGeneration }));
        }
        if (url.includes(CAN_COMMENT)) return Promise.resolve(res(200, { commentPolicy: 'open', canComment: true }));
        // The first-generation token is rejected as expired; the second is accepted.
        if (auth === 'Bearer token.gen1') {
          listSeenStale = true;
          return Promise.resolve(res(401, {}));
        }
        return Promise.resolve(res(200, { commentPolicy: 'open', annotations: [] }));
      })
    );

    await runWidget();
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenGeneration).toBe(1);

    // The poll loop is armed at init, before the panel opened, so the first tick is the
    // closed-panel cadence (60s) rather than the open one.
    await vi.advanceTimersByTimeAsync(70000); // a poll fires with the now-stale token

    expect(listSeenStale).toBe(true);
    expect(tokenGeneration).toBe(2); // re-exchanged rather than dead-ending
  });
});

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
 * Route fetches by URL.
 *  - `gated`      401s the list until a credential is presented (the recoverable case)
 *  - `neverAdmits` 401s the list NO MATTER WHAT, which is the passphrase-gated artifact viewed
 *    by a non-owner: the proof is a cookie, so no Bearer can ever satisfy it. This is the shape
 *    that ran away, re-exchanging once per poll forever.
 *  - `cookieAdmits` 401s the list until the proof cookie rides along, which is the passphrase-
 *    gated artifact the viewer has ALREADY UNLOCKED - the configuration the escalation ladder
 *    exists to serve, and the one where a ladder that is re-climbed every poll runs away in the
 *    success case rather than the failure one.
 */
function stubFetch(opts: { signedIn: boolean; gated?: boolean; neverAdmits?: boolean; cookieAdmits?: boolean }) {
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const authed = !!(init?.headers as Record<string, string> | undefined)?.Authorization;

    if (url.includes(REFRESH)) {
      return Promise.resolve(opts.signedIn ? res(200, { accessToken: 'fresh.token' }) : res(401, {}));
    }
    if (opts.neverAdmits && !url.includes(CAN_COMMENT)) {
      return Promise.resolve(res(401, { error: 'Passphrase required' }));
    }
    if (opts.cookieAdmits && !url.includes(CAN_COMMENT) && init?.credentials !== 'same-origin') {
      return Promise.resolve(res(401, { error: 'Passphrase required' }));
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

function listCalls(): StubbedCall[] {
  return calls.filter(c => !c.url.includes(REFRESH) && !c.url.includes(CAN_COMMENT));
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

  // REGRESSION GUARD. The retry was bounded within one authedFetch call but not across calls:
  // every poll started fresh, saw a token was held, took the force branch and minted a new one.
  // On a passphrase-gated artifact viewed by a non-owner - a 401 no Bearer can ever fix - that
  // was one exchange per poll cycle, indefinitely, against a 60/min per-IP limit. The earlier
  // traffic tests pinned the LOWER bound (zero when unused); this pins the upper one.
  it('stops re-exchanging once a fresh credential still cannot satisfy the gate', async () => {
    stubFetch({ signedIn: true, neverAdmits: true });

    await runWidget();
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);
    const afterOpen = refreshCalls().length;

    await vi.advanceTimersByTimeAsync(10 * 60_000); // ten closed-panel poll cycles

    // Flat, not growing. Before the latch this was afterOpen + one per cycle.
    expect(refreshCalls()).toHaveLength(afterOpen);
  });

  it('escalates to sending credentials so a passphrase proof cookie can satisfy the gate', async () => {
    // The proof is an HttpOnly per-artifact cookie, so a request with credentials omitted can
    // never pass the gate however good its Bearer is. Escalation happens only after a 401, which
    // is what keeps the cacheable open-public path cookie-free.
    stubFetch({ signedIn: true, neverAdmits: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(0);

    const listCalls = calls.filter(c => !c.url.includes(REFRESH) && !c.url.includes(CAN_COMMENT));
    expect(listCalls[0]?.init?.credentials).toBe('omit'); // first attempt stays cookie-free
    expect(listCalls.some(c => c.init?.credentials === 'same-origin')).toBe(true);
  });

  // REGRESSION GUARD, the mirror of the one above. The latch only fired when the top of the
  // ladder FAILED, so when it SUCCEEDED nothing was remembered: every later request restarted at
  // stage 0, where a token is always held by then, and minted a fresh one. On a passphrase-gated
  // artifact the viewer has unlocked - where only the cookie stage ever gets in - that was again
  // one exchange per poll forever, plus 3x list amplification.
  it('settles on the stage that worked instead of re-climbing the ladder every poll', async () => {
    stubFetch({ signedIn: true, cookieAdmits: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls()).toHaveLength(1);
    expect(listCalls()).toHaveLength(3); // the ladder, climbed once: omit -> omit+Bearer -> cookie

    await vi.advanceTimersByTimeAsync(10 * 60_000); // ten closed-panel poll cycles

    // Flat, not growing: the exchange is not repeated, and each poll costs ONE list request
    // rather than re-walking all three.
    expect(refreshCalls()).toHaveLength(1);
    expect(listCalls()).toHaveLength(13);
    expect(
      listCalls()
        .slice(3)
        .every(c => c.init?.credentials === 'same-origin')
    ).toBe(true);
  });

  it('sends the proof cookie for a signed-out viewer who has unlocked the gate', async () => {
    // checkAccessGate admits on passphraseVerified ALONE, with no user - so escalation to the
    // cookie must not be conditional on having obtained a token, or the #1811 symptom (existing
    // comments invisible to a reader allowed to see them) survives on the passphrase rung for
    // every viewer without a session.
    stubFetch({ signedIn: false, cookieAdmits: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(0);

    expect(listCalls().some(c => c.init?.credentials === 'same-origin')).toBe(true);
    expect(document.getElementById('b4m-launch')?.textContent).toContain('1');
    expect(refreshCalls()).toHaveLength(1); // still exactly one attempt per page
  });

  it('keeps the open-public list request cookie-free, since it never 401s', async () => {
    stubFetch({ signedIn: true });

    await runWidget();
    await vi.advanceTimersByTimeAsync(120_000);

    const listCalls = calls.filter(c => !c.url.includes(REFRESH) && !c.url.includes(CAN_COMMENT));
    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls.every(c => c.init?.credentials === 'omit')).toBe(true);
  });

  it('does not paint "Sign in to comment" at a signed-in viewer while capability is unknown', async () => {
    // openPanel renders synchronously, before the credential exists. Gating the prompt on
    // !token alone showed a signed-in viewer the one string this change exists to remove.
    stubFetch({ signedIn: true });
    await runWidget();

    clickLauncher(); // synchronous render, nothing resolved yet
    expect(document.getElementById('b4m-signin')).toBeNull();

    await vi.advanceTimersByTimeAsync(0);
    expect(document.getElementById('b4m-ta')).not.toBeNull();
  });

  it('skips the can-comment round trip entirely for a signed-out viewer', async () => {
    stubFetch({ signedIn: false });

    await runWidget();
    clickLauncher();
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.some(c => c.url.includes(CAN_COMMENT))).toBe(false);
    expect(document.getElementById('b4m-signin')).not.toBeNull();
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

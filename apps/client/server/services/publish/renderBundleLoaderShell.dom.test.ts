// @vitest-environment jsdom
//
// EXECUTION coverage for the gated-bundle loader shell. Every other test asserts the shell as a
// static string, which is exactly why #1710 shipped green: the shell read a credential out of
// localStorage, #1346 moved the refresh token into an HttpOnly cookie and made the access token
// memory-only, and no test ever RAN the bootstrap to discover the read now returns undefined.
// The visibility ladder itself was well covered - it was the credential-recovery leg in front of
// it that was dead, so these tests eval the real inline bootstrap against a stubbed fetch and
// assert the viewer actually receives bundle bytes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderBundleLoaderShell } from './renderBundleLoaderShell';

/** The bootstrap is the FIRST inline script in the shell (the second is the hash bridge). */
function bootstrapSource(): string {
  const shell = renderBundleLoaderShell();
  const match = /<script>([\s\S]*?)<\/script>/.exec(shell);
  if (!match) throw new Error('loader shell has no inline bootstrap script');
  return match[1];
}

interface StubbedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: StubbedCall[] = [];

/** Route each fetch by URL so a test can describe a session state rather than a call order. */
function stubFetch(routes: { refresh: () => Response; raw?: () => Response }) {
  const fetchStub = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('/api/auth/refreshToken')) return Promise.resolve(routes.refresh());
    if (routes.raw) return Promise.resolve(routes.raw());
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

function json(status: number, body: unknown): Response {
  return { status, json: () => Promise.resolve(body), text: () => Promise.resolve('') } as Response;
}

function html(status: number, body: string): Response {
  return { status, text: () => Promise.resolve(body), json: () => Promise.resolve({}) } as Response;
}

function mountShell(): { frame: HTMLIFrameElement; msg: HTMLElement } {
  document.body.innerHTML = '<iframe id="b4m-frame" style="display:none"></iframe><div id="b4m-msg"></div>';
  return {
    frame: document.getElementById('b4m-frame') as HTMLIFrameElement,
    msg: document.getElementById('b4m-msg') as HTMLElement,
  };
}

/** Run the bootstrap and let its promise chain settle. */
async function runBootstrap(): Promise<void> {
  // eval, deliberately: executing the REAL shipped bootstrap is the whole point - a test that
  // reimplemented it would have passed straight through #1710.
  eval(bootstrapSource());
  await vi.advanceTimersByTimeAsync(0);
}

describe('loader shell bootstrap - execution', () => {
  beforeEach(() => {
    calls = [];
    vi.useFakeTimers();
    mountShell();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the bundle for a viewer whose session lives only in the refresh cookie', async () => {
    // The #1710 case: an org member with a perfectly good session and NOTHING in localStorage.
    stubFetch({
      refresh: () => json(200, { accessToken: 'fresh.access.token' }),
      raw: () => html(200, '<h1>org only</h1>'),
    });

    await runBootstrap();

    const frame = document.getElementById('b4m-frame') as HTMLIFrameElement;
    expect(frame.srcdoc).toBe('<h1>org only</h1>');
    expect(frame.style.display).toBe('block');
    expect((document.getElementById('b4m-msg') as HTMLElement).style.display).toBe('none');
  });

  it('never reads localStorage for a credential', async () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem');
    stubFetch({ refresh: () => json(200, { accessToken: 't' }), raw: () => html(200, 'ok') });

    await runBootstrap();

    expect(getItem).not.toHaveBeenCalled();
  });

  it('exchanges the cookie with a same-origin POST and forwards the token as a Bearer header', async () => {
    stubFetch({ refresh: () => json(200, { accessToken: 'fresh.access.token' }), raw: () => html(200, 'ok') });

    await runBootstrap();

    const refresh = calls.find(c => c.url.includes('/api/auth/refreshToken'));
    expect(refresh?.init?.method).toBe('POST');
    // 'same-origin' is what actually sends the HttpOnly cookie; 'omit' here is the bug.
    expect(refresh?.init?.credentials).toBe('same-origin');

    const raw = calls.find(c => c.url.includes('raw=1'));
    expect((raw?.init?.headers as Record<string, string>).Authorization).toBe('Bearer fresh.access.token');
    // The recovered token is the ONLY credential on the artifact fetch - no ambient cookie.
    expect(raw?.init?.credentials).toBe('omit');
  });

  it('offers sign-in to a viewer with no session, without fetching the artifact', async () => {
    stubFetch({ refresh: () => json(401, { error: 'Refresh token is required' }) });

    await runBootstrap();

    const msg = document.getElementById('b4m-msg') as HTMLElement;
    expect(msg.textContent).toContain('Sign in to view this shared item');
    expect(msg.querySelector('a')?.getAttribute('href')).toContain('/login?redirectTo=');
    expect(calls.some(c => c.url.includes('raw=1'))).toBe(false);
    // Terminal, not retried: 401 is the ordinary answer for a signed-out viewer.
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.filter(c => c.url.includes('/api/auth/refreshToken'))).toHaveLength(1);
  });

  it('tells a non-member they lack access rather than telling them to sign in', async () => {
    // A live session that simply is not in the artifact's org. Sending this viewer to /login
    // is a loop that cannot help them, which is the ambiguity #1710 called out.
    stubFetch({ refresh: () => json(200, { accessToken: 't' }), raw: () => html(403, '') });

    await runBootstrap();

    const msg = document.getElementById('b4m-msg') as HTMLElement;
    expect(msg.textContent).toContain('You do not have access to this shared item');
    expect(msg.textContent).not.toContain('Sign in to view');
    expect(document.getElementById('b4m-frame')).toBeNull(); // frame torn down on a terminal state
  });

  it('prompts a real re-login when the recovered token is rejected', async () => {
    stubFetch({ refresh: () => json(200, { accessToken: 'stale' }), raw: () => html(401, '') });

    await runBootstrap();
    // A 401 on the artifact fetch is retried (cold-Lambda tolerance) before it is terminal.
    await vi.advanceTimersByTimeAsync(5000);

    const msg = document.getElementById('b4m-msg') as HTMLElement;
    expect(msg.textContent).toContain('Your session has ended');
    expect(msg.querySelector('a')?.getAttribute('href')).toContain('/login?redirectTo=');
  });

  it('retries a transient failure of the token exchange before giving up', async () => {
    let attempts = 0;
    stubFetch({
      refresh: () => {
        attempts++;
        return attempts < 3 ? json(503, {}) : json(200, { accessToken: 'late.but.valid' });
      },
      raw: () => html(200, '<h1>recovered</h1>'),
    });

    await runBootstrap();
    await vi.advanceTimersByTimeAsync(5000);

    expect(attempts).toBe(3);
    expect((document.getElementById('b4m-frame') as HTMLIFrameElement).srcdoc).toBe('<h1>recovered</h1>');
  });
});

// @vitest-environment jsdom
//
// EXECUTION coverage for the passphrase prompt shell's owner-bypass path.
//
// The shell is a string of vanilla JS, so a static assertion cannot tell whether the owner is
// actually admitted or whether every other viewer still lands on the form. These eval the real
// shipped script against a stubbed fetch, in the same shape as renderBundleLoaderShell.dom.test.
//
// The negative cases are the load-bearing ones: a non-owner, an anonymous viewer, and a viewer
// whose network is failing must ALL still reach the passphrase form. A bug that admitted the
// wrong person would be a gate bypass, and a bug that hid the form would lock everyone out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderPassphraseShell } from './renderPassphraseShell';

const OWNER_ROUTE = '/api/publish/gate/owner';
const PASSPHRASE_ROUTE = '/api/publish/gate/passphrase';
const REFRESH = '/api/auth/refreshToken';

interface StubbedCall {
  url: string;
  init: RequestInit | undefined;
}

let calls: StubbedCall[] = [];
let reload: ReturnType<typeof vi.fn>;

/** Both inline scripts, in document order: the shared exchange helper, then the bootstrap. */
function shellScripts(): string {
  const html = renderPassphraseShell();
  const found = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (found.length !== 2) throw new Error(`expected 2 inline scripts, got ${found.length}`);
  return found.join('\n');
}

/** Mount the shell's markup so the bootstrap finds its nodes. */
function mountShell(): void {
  const html = renderPassphraseShell();
  const body = /<body>([\s\S]*?)<script>/.exec(html);
  if (!body) throw new Error('could not extract shell body');
  document.body.innerHTML = body[1];
}

function res(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body ?? {}),
    text: () => Promise.resolve(''),
    headers: { get: () => null },
  } as unknown as Response;
}

/** `ownerStatus` is what /gate/owner answers: 204 admits, 403 is a non-owner, 401 anonymous. */
function stubFetch(opts: { signedIn: boolean; ownerStatus?: number; hang?: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (opts.hang) return new Promise<Response>(() => {}); // never settles
      if (url.includes(REFRESH)) {
        return Promise.resolve(opts.signedIn ? res(200, { accessToken: 'tok' }) : res(401));
      }
      if (url.includes(OWNER_ROUTE)) return Promise.resolve(res(opts.ownerStatus ?? 403));
      if (url.includes(PASSPHRASE_ROUTE)) return Promise.resolve(res(204));
      throw new Error('unexpected fetch: ' + url);
    })
  );
}

const form = () => document.getElementById('b4m-pp-form') as HTMLFormElement;
const formVisible = () => form()?.style.visibility === 'visible';
const called = (route: string) => calls.some(c => c.url.includes(route));

async function runShell(): Promise<void> {
  // eval, deliberately: the point is to execute the REAL shipped script.
  eval(shellScripts());
  await vi.advanceTimersByTimeAsync(0);
}

describe('passphrase shell - owner bypass', () => {
  beforeEach(() => {
    calls = [];
    reload = vi.fn();
    vi.useFakeTimers();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/p/u/scope/my-slug', search: '', href: 'http://localhost/p/u/scope/my-slug', reload },
    });
    mountShell();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts with the form hidden so the owner never sees a prompt they do not need', () => {
    expect(form().style.visibility).toBe('hidden');
  });

  it('admits the owner by minting the proof cookie and reloading, without showing the form', async () => {
    stubFetch({ signedIn: true, ownerStatus: 204 });

    await runShell();

    expect(called(REFRESH)).toBe(true);
    const ownerCall = calls.find(c => c.url.includes(OWNER_ROUTE));
    expect((ownerCall?.init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(ownerCall?.init?.credentials).toBe('include'); // the minted cookie must be accepted
    expect(JSON.parse(String(ownerCall?.init?.body))).toEqual({ path: '/p/u/scope/my-slug' });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(formVisible()).toBe(false);
  });

  it('shows the form to a signed-in viewer who is NOT the owner', async () => {
    stubFetch({ signedIn: true, ownerStatus: 403 });

    await runShell();

    expect(called(OWNER_ROUTE)).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(formVisible()).toBe(true);
  });

  it('shows the form to an anonymous viewer without ever asking about ownership', async () => {
    stubFetch({ signedIn: false });

    await runShell();

    expect(called(REFRESH)).toBe(true);
    expect(called(OWNER_ROUTE)).toBe(false); // no token, nothing to ask
    expect(formVisible()).toBe(true);
  });

  it('reveals the form on the timeout when the check never comes back', async () => {
    // A hung or failing network must not strand a viewer who has the passphrase in hand.
    stubFetch({ signedIn: true, hang: true });

    await runShell();
    expect(formVisible()).toBe(false); // still waiting

    await vi.advanceTimersByTimeAsync(1500);

    expect(formVisible()).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it('still unlocks on a correct passphrase for a non-owner', async () => {
    stubFetch({ signedIn: false });
    await runShell();
    expect(formVisible()).toBe(true);

    (document.getElementById('b4m-pp-input') as HTMLInputElement).value = 'correct horse';
    form().dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    const unlock = calls.find(c => c.url.includes(PASSPHRASE_ROUTE));
    expect(JSON.parse(String(unlock?.init?.body))).toEqual({
      path: '/p/u/scope/my-slug',
      passphrase: 'correct horse',
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('makes no ownership check at all inside a framed render', async () => {
    // A sandboxed frame has no credentials to recover and cannot submit the form either; the
    // shell swaps to open-in-own-tab guidance before any of this runs.
    Object.defineProperty(window, 'top', { configurable: true, value: {} });
    stubFetch({ signedIn: true, ownerStatus: 204 });

    await runShell();

    expect(calls).toHaveLength(0);
    expect(document.getElementById('b4m-pp-form')).toBeNull();
    expect(document.getElementById('b4m-pp-hint')?.textContent).toContain('own tab');
  });
});

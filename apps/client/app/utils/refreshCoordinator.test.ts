import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { api } from '@client/app/contexts/apiClient';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { listenForSiblingRefresh, refreshSession, resetRefreshCoordinator } from './refreshCoordinator';

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

const make401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: {},
    headers: {},
    config,
  } as AxiosResponse);

/** An unsigned JWT carrying a `sid` claim. Adoption binds to that claim, so the coordinator's
 *  fixtures have to be token-shaped rather than opaque strings. */
const token = (sid: string, label: string) =>
  `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify({ sid, label }))}.sig`;

const SID = 'session-1';

/** Minimal Web Locks stand-in: jsdom ships none, and the queueing behaviour is the whole point. */
const installLockManager = () => {
  const queues = new Map<string, Promise<unknown>>();
  const request = vi.fn(async (name: string, callback: () => Promise<unknown>) => {
    const prior = queues.get(name) ?? Promise.resolve();
    const run = prior.then(callback, callback);
    // Keep the chain alive even when a holder rejects, mirroring a real lock release.
    queues.set(
      name,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return request;
};

describe('refreshCoordinator', () => {
  let realAdapter: AxiosAdapter | undefined;

  beforeEach(() => {
    resetRefreshCoordinator();
    useAccessToken.setState({
      accessToken: token(SID, 'stale'),
      expired: false,
      mfaPending: false,
      hasSession: true,
    });
    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
  });

  afterEach(() => {
    api.defaults.adapter = realAdapter;
    Reflect.deleteProperty(navigator, 'locks');
    vi.restoreAllMocks();
  });

  it('collapses a burst of concurrent callers into a single exchange', async () => {
    let calls = 0;
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      calls += 1;
      return ok(config, { accessToken: token(SID, 'fresh') });
    }) as AxiosAdapter;

    const results = await Promise.all([refreshSession(), refreshSession(), refreshSession()]);

    expect(calls).toBe(1);
    expect(results.every(r => r.accessToken === token(SID, 'fresh'))).toBe(true);
    expect(useAccessToken.getState().accessToken).toBe(token(SID, 'fresh'));
  });

  /**
   * Two tabs, not two calls: each tab has its own in-tab guard, so resetting between the two
   * `refreshSession()` calls is what makes them independent flights. Both are started before
   * either resolves, so both capture the same stale baseline - the real shape of N tabs waking on
   * a shared exp claim.
   */
  const twoTabs = async () => {
    const first = refreshSession();
    resetRefreshCoordinator();
    const second = refreshSession();
    return { first: await first, second: await second };
  };

  it('serializes through the cross-tab lock so two tabs never exchange at once', async () => {
    const request = installLockManager();
    let inFlight = 0;
    let overlapped = false;
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight -= 1;
      return ok(config, { accessToken: token(SID, 'fresh') });
    }) as AxiosAdapter;

    await twoTabs();

    expect(overlapped).toBe(false);
    expect(request).toHaveBeenCalledWith('b4m.auth.refresh', expect.any(Function));
  });

  it('adopts the token that landed while it waited for the lock instead of exchanging again', async () => {
    installLockManager();
    let calls = 0;
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      calls += 1;
      return ok(config, { accessToken: token(SID, `fresh-${calls}`) });
    }) as AxiosAdapter;

    const { second } = await twoTabs();

    // The queued tab found the token already replaced and took it, rather than spending a second
    // rotation of the one shared cookie.
    expect(calls).toBe(1);
    expect(second.accessToken).toBe(token(SID, 'fresh-1'));
  });

  it('rejects with the axios error so callers can tell a rejected credential from an outage', async () => {
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      throw make401(config);
    }) as AxiosAdapter;

    await expect(refreshSession()).rejects.toMatchObject({ response: { status: 401 } });
    // A failed exchange must not leave the guard latched, or every later refresh returns the
    // same rejection forever.
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) =>
      ok(config, { accessToken: token(SID, 'fresh') })) as AxiosAdapter;
    await expect(refreshSession()).resolves.toMatchObject({ accessToken: token(SID, 'fresh') });
  });

  describe('sibling-tab adoption', () => {
    /** Post as another tab would and let the message loop deliver it. */
    const broadcastFromSibling = async (payload: unknown) => {
      const sibling = new BroadcastChannel('b4m.auth');
      sibling.postMessage(payload);
      await new Promise(resolve => setTimeout(resolve, 0));
      sibling.close();
    };

    const fromSibling = token(SID, 'from-sibling');

    it("takes a sibling's freshly minted token without a round trip of its own", async () => {
      const stop = listenForSiblingRefresh();
      api.defaults.adapter = (() => {
        throw new Error('must not exchange - the token was handed to us');
      }) as unknown as AxiosAdapter;

      await broadcastFromSibling({ type: 'refreshed', sid: SID, accessToken: fromSibling, impersonating: false });

      expect(useAccessToken.getState().accessToken).toBe(fromSibling);
      stop();
    });

    it.each([
      ['mid-MFA', { mfaPending: true, expired: false }],
      ['already torn down', { mfaPending: false, expired: true }],
    ])('ignores a broadcast while %s, so a shed session is never resurrected', async (_label, state) => {
      const stop = listenForSiblingRefresh();
      // Deliberately keeps a real held token for the SAME session. With accessToken: null the sid
      // check short-circuits first and this case passes even with the mfaPending/expired guard
      // deleted - so the property it exists to pin would not actually be pinned.
      const held = token(SID, 'held');
      useAccessToken.setState({ accessToken: held, ...state });

      await broadcastFromSibling({ type: 'refreshed', sid: SID, accessToken: fromSibling, impersonating: false });

      expect(useAccessToken.getState().accessToken).toBe(held);
      stop();
    });

    it('ignores a broadcast naming a DIFFERENT session', async () => {
      // A BroadcastChannel is same-origin but not same-author, so anything on the page can post to
      // it. Binding adoption to the sid this tab already holds stops that being a cheap way to swap
      // a tab onto an attacker-chosen session.
      const stop = listenForSiblingRefresh();
      const held = useAccessToken.getState().accessToken;

      await broadcastFromSibling({
        type: 'refreshed',
        sid: 'someone-elses-session',
        accessToken: token('someone-elses-session', 'evil'),
        impersonating: false,
      });

      expect(useAccessToken.getState().accessToken).toBe(held);
      stop();
    });
  });

  it('migrates a pre-cookie session by sending its localStorage token once', async () => {
    localStorage.setItem(
      'access-token-storage',
      JSON.stringify({ state: { refreshToken: 'legacy-token' }, version: 0 })
    );
    // The store lifts the legacy token out during rehydration (migrate), so re-import state.
    useAccessToken.persist.rehydrate();

    const bodies: unknown[] = [];
    api.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
      bodies.push(JSON.parse(String(config.data ?? '{}')));
      return ok(config, { accessToken: token(SID, 'fresh') });
    }) as AxiosAdapter;

    await refreshSession();
    resetRefreshCoordinator();
    useAccessToken.setState({ accessToken: 'stale-again' }); // force a real second exchange
    await refreshSession();

    expect(bodies[0]).toMatchObject({ token: 'legacy-token', cookie: true });
    // Single-use: a second exchange must not replay a token the first one already migrated.
    expect(bodies[1]).toEqual({});
    localStorage.clear();
  });
});

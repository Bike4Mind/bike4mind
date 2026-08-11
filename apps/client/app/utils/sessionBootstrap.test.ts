import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import {
  shouldRevalidateOnFocus,
  revalidateSessionOnFocus,
  probeIdentity,
  resetProbeGuardForTests,
} from './sessionBootstrap';

/** A macrotask flush - long enough for a settled promise's .catch().finally() chain to run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const makeQueryClient = (setQueryData: ReturnType<typeof vi.fn>): QueryClient =>
  ({ setQueryData }) as unknown as QueryClient;

/** Builds an unsigned JWT carrying only the given claims - decodeTokenExpiryMs never verifies
 *  the signature, so a fake one is enough to exercise the exp-gating branch. */
const makeToken = (claims: Record<string, unknown>) =>
  `${btoa(JSON.stringify({ alg: 'none' }))}.${btoa(JSON.stringify(claims))}.sig`;

const base = {
  visibilityState: 'visible' as DocumentVisibilityState,
  accessToken: 'tok',
  mfaPending: false,
  expired: false,
  pathname: '/new',
};

describe('shouldRevalidateOnFocus - refocus liveness-check gate', () => {
  it('revalidates when the tab is visible and holding a token', () => {
    expect(shouldRevalidateOnFocus(base)).toBe(true);
  });

  it('does not revalidate when the tab is not the visible one', () => {
    expect(shouldRevalidateOnFocus({ ...base, visibilityState: 'hidden' })).toBe(false);
  });

  it('does not revalidate when there is no access token (logged-out tab)', () => {
    expect(shouldRevalidateOnFocus({ ...base, accessToken: null })).toBe(false);
  });

  it('does not revalidate during mfaPending (no refresh token by design - mirrors ApiContext)', () => {
    expect(shouldRevalidateOnFocus({ ...base, mfaPending: true })).toBe(false);
  });

  it('does not revalidate once the session is already torn down', () => {
    expect(shouldRevalidateOnFocus({ ...base, expired: true })).toBe(false);
  });

  it('does not revalidate on a public path', () => {
    expect(shouldRevalidateOnFocus({ ...base, pathname: '/login' })).toBe(false);
  });
});

describe('shouldRevalidateOnFocus - exp-claim gating (the common refocus should be free)', () => {
  const nowMs = 1_700_000_000_000;

  it('revalidates when the token is already expired', () => {
    const token = makeToken({ exp: Math.floor(nowMs / 1000) - 60 });
    expect(shouldRevalidateOnFocus({ ...base, accessToken: token, nowMs })).toBe(true);
  });

  it('revalidates when the token is within the buffer of expiring', () => {
    const token = makeToken({ exp: Math.floor(nowMs / 1000) + 10 }); // 10s out; buffer is 30s
    expect(shouldRevalidateOnFocus({ ...base, accessToken: token, nowMs })).toBe(true);
  });

  it('skips the round trip when the token is nowhere near expiring', () => {
    const token = makeToken({ exp: Math.floor(nowMs / 1000) + 60 * 20 }); // 20 minutes out
    expect(shouldRevalidateOnFocus({ ...base, accessToken: token, nowMs })).toBe(false);
  });

  it('revalidates when the token has no readable exp claim (fail-safe, not fail-silent)', () => {
    expect(shouldRevalidateOnFocus({ ...base, accessToken: 'not-a-jwt', nowMs })).toBe(true);
  });
});

describe('probeIdentity - shared single-flight liveness probe', () => {
  beforeEach(() => {
    resetProbeGuardForTests();
    vi.restoreAllMocks();
  });

  it('writes a successful response into the identify query cache', async () => {
    const identify = { user: { id: 'u1' }, accessToken: 'fresh' };
    const apiGet = vi.spyOn(api, 'get').mockResolvedValue({ data: identify });
    const setQueryData = vi.fn();

    await probeIdentity(makeQueryClient(setQueryData));

    expect(apiGet).toHaveBeenCalledWith('/api/identify');
    expect(setQueryData).toHaveBeenCalledWith(['identify'], identify);
  });

  it('does not touch the cache on a failed probe (a transient network error must not poison the identify query)', async () => {
    const apiGet = vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'));
    const setQueryData = vi.fn();

    await probeIdentity(makeQueryClient(setQueryData));

    expect(apiGet).toHaveBeenCalledWith('/api/identify');
    expect(setQueryData).not.toHaveBeenCalled();
  });

  it('collapses a second call that lands while the first probe is still in flight', async () => {
    let resolveFirst: ((v: { data: unknown }) => void) | undefined;
    const apiGet = vi.spyOn(api, 'get');
    // The first call hangs until resolved manually; every later call resolves immediately -
    // otherwise the final probeIdentity call below would await a promise nothing ever settles.
    apiGet.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveFirst = resolve;
        })
    );
    apiGet.mockResolvedValue({ data: { user: {}, accessToken: 'x' } });
    const setQueryData = vi.fn();
    const client = makeQueryClient(setQueryData);

    const first = probeIdentity(client);
    const second = probeIdentity(client);
    expect(apiGet).toHaveBeenCalledTimes(1);

    resolveFirst?.({ data: { user: {}, accessToken: 'x' } });
    await Promise.all([first, second]);

    // The in-flight guard cleared after the first probe settled - a later call fires again.
    await probeIdentity(client);
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

describe('revalidateSessionOnFocus - guard gating the shared probe', () => {
  beforeEach(() => {
    resetProbeGuardForTests();
    vi.restoreAllMocks();
    useAccessToken.setState({
      accessToken: 'tok',
      expired: false,
      expiredReason: null,
      mfaPending: false,
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname: '/new' },
    });
  });

  it('probes the identify endpoint when the guard passes', async () => {
    const apiGet = vi.spyOn(api, 'get').mockResolvedValue({ data: { user: {}, accessToken: 'tok' } });
    const setQueryData = vi.fn();

    revalidateSessionOnFocus(makeQueryClient(setQueryData));
    await flush();

    expect(apiGet).toHaveBeenCalledWith('/api/identify');
  });

  it('does not probe when the guard fails (e.g. mfaPending)', async () => {
    useAccessToken.setState({ mfaPending: true });
    const apiGet = vi.spyOn(api, 'get').mockResolvedValue({ data: { user: {}, accessToken: 'tok' } });
    const setQueryData = vi.fn();

    revalidateSessionOnFocus(makeQueryClient(setQueryData));
    await flush();

    expect(apiGet).not.toHaveBeenCalled();
  });
});

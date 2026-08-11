import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import {
  shouldRevalidateOnFocus,
  revalidateSessionOnFocus,
  probeIdentity,
  resetProbeGuardForTests,
} from './sessionBootstrap';

/** A macrotask flush - long enough for a settled promise's .catch().finally() chain to run. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const makeQueryClient = (refetchQueries: ReturnType<typeof vi.fn>): QueryClient =>
  ({ refetchQueries }) as unknown as QueryClient;

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

describe('probeIdentity - shared single-flight liveness probe', () => {
  beforeEach(() => {
    resetProbeGuardForTests();
  });

  it('refetches the identify query through the shared query client', async () => {
    const refetchQueries = vi.fn().mockResolvedValue(undefined);

    await probeIdentity(makeQueryClient(refetchQueries));

    expect(refetchQueries).toHaveBeenCalledWith({ queryKey: ['identify'] });
  });

  it('collapses a second call that lands while the first probe is still in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    // The first call hangs until resolved manually; every later call resolves immediately -
    // otherwise the final probeIdentity call below would await a promise nothing ever settles.
    const refetchQueries = vi.fn().mockResolvedValue(undefined);
    refetchQueries.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveFirst = resolve;
        })
    );
    const client = makeQueryClient(refetchQueries);

    const first = probeIdentity(client);
    const second = probeIdentity(client);
    expect(refetchQueries).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await Promise.all([first, second]);

    // The in-flight guard cleared after the first probe settled - a later call fires again.
    await probeIdentity(client);
    expect(refetchQueries).toHaveBeenCalledTimes(2);
  });
});

describe('revalidateSessionOnFocus - guard gating the shared probe', () => {
  beforeEach(() => {
    resetProbeGuardForTests();
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

  it('probes the identify query through the given client when the guard passes', async () => {
    const refetchQueries = vi.fn().mockResolvedValue(undefined);

    revalidateSessionOnFocus(makeQueryClient(refetchQueries));
    await flush();

    expect(refetchQueries).toHaveBeenCalledWith({ queryKey: ['identify'] });
  });

  it('does not probe when the guard fails (e.g. mfaPending)', async () => {
    useAccessToken.setState({ mfaPending: true });
    const refetchQueries = vi.fn().mockResolvedValue(undefined);

    revalidateSessionOnFocus(makeQueryClient(refetchQueries));
    await flush();

    expect(refetchQueries).not.toHaveBeenCalled();
  });
});

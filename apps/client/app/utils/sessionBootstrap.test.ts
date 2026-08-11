import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from '@client/app/contexts/ApiContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { shouldRevalidateOnFocus, revalidateSessionOnFocus } from './sessionBootstrap';

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

describe('revalidateSessionOnFocus - probe firing + single-flight', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAccessToken.setState({
      accessToken: 'tok',
      refreshToken: 'refresh',
      expired: false,
      expiredReason: null,
      mfaPending: false,
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, pathname: '/new' },
    });
  });

  it('pings /api/identify through the shared api instance when the guard passes', () => {
    const apiGet = vi.spyOn(api, 'get').mockResolvedValue({ data: {} });

    revalidateSessionOnFocus();

    expect(apiGet).toHaveBeenCalledWith('/api/identify');
  });

  it('does not ping when the guard fails (e.g. mfaPending)', () => {
    useAccessToken.setState({ mfaPending: true });
    const apiGet = vi.spyOn(api, 'get').mockResolvedValue({ data: {} });

    revalidateSessionOnFocus();

    expect(apiGet).not.toHaveBeenCalled();
  });

  it('collapses a second call that lands while the first probe is still in flight', async () => {
    let resolveFirst: (() => void) | undefined;
    const apiGet = vi.spyOn(api, 'get').mockImplementation(
      () =>
        new Promise(resolve => {
          resolveFirst = () => resolve({ data: {} });
        })
    );

    revalidateSessionOnFocus();
    revalidateSessionOnFocus();
    expect(apiGet).toHaveBeenCalledTimes(1);

    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    // The in-flight guard cleared after the first probe settled - a later call fires again.
    revalidateSessionOnFocus();
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});

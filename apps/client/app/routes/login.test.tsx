import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';
import { api, resetRedirectingGuard } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { ACCESS_TOKEN_STORAGE_KEY, useAccessToken } from '@client/app/hooks/useAccessToken';
import { resetRefreshCoordinator } from '@client/app/utils/refreshCoordinator';
import { resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import LoginPage from './login';

// useRouter hands back the same router on every render; a fresh object each time would re-run the page's effect.
const { history, router } = vi.hoisted(() => {
  const history = { push: vi.fn(), replace: vi.fn() };
  return { history, router: { history } };
});

vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));
vi.mock('@client/app/components/MultiStepLogin', () => ({
  default: () => <div data-testid="login-form" />,
}));
vi.mock('@client/app/hooks/data/settings', () => ({ usePublicConfig: () => ({ data: undefined }) }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: { getState: () => ({ resetSettings: vi.fn() }) },
}));
vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

const appTheme = extendTheme({ ...getThemeConfig() });

const signedInUser = { id: 'u1', username: 'rider', email: 'rider@example.com' };

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

const make401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: { error: 'No refresh token' },
    headers: {},
    config,
  } as AxiosResponse);

/** Answers the cookie exchange the way the server does for a browser that holds (or lacks) a session. */
const serveRefresh = (hasCookie: boolean) => {
  const calls: string[] = [];
  api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
    calls.push(config.url ?? '');
    if (config.url === '/api/auth/refreshToken' && hasCookie) {
      return Promise.resolve(ok(config, { accessToken: 'fresh-access', user: signedInUser }));
    }
    return Promise.reject(make401(config));
  }) as AxiosAdapter;
  return calls;
};

const renderLogin = (url: string) => {
  window.history.replaceState(null, '', url);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <LoginPage />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const signedInElsewhere = (hasSession: boolean) =>
  new StorageEvent('storage', {
    key: ACCESS_TOKEN_STORAGE_KEY,
    newValue: JSON.stringify({ state: { hasSession, expired: false, expiredReason: null }, version: 1 }),
  });

describe('LoginPage - resuming an existing session', () => {
  let realAdapter: AxiosAdapter | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetSessionBootstrap();
    resetRefreshCoordinator();
    resetRedirectingGuard();
    useAccessToken.setState({ accessToken: null, hasSession: false, mfaPending: false, expired: false });
    useUser.setState({ currentUser: null });
    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    api.defaults.adapter = realAdapter;
    errorSpy.mockRestore();
    window.history.replaceState(null, '', '/');
    vi.clearAllMocks();
  });

  it('forwards a signed-in visitor to redirectTo without showing the form or clearing caches', async () => {
    useAccessToken.setState({ hasSession: true });
    const calls = serveRefresh(true);

    renderLogin('/login?redirectTo=%2Foauth%2Fauthorize%3Fclient_id%3Dpaintbox%26state%3Dabc');

    expect(screen.getByTestId('login-session-check-spinner')).toBeTruthy();
    await waitFor(() => expect(history.replace).toHaveBeenCalledWith('/oauth/authorize?client_id=paintbox&state=abc'));
    expect(history.replace).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['/api/auth/refreshToken']);
    expect(screen.queryByTestId('login-form')).toBeNull();
    expect(clearClientCaches).not.toHaveBeenCalled();
    expect(useAccessToken.getState().accessToken).toBe('fresh-access');
    expect(useUser.getState().currentUser?.id).toBe('u1');
  });

  it('falls back to /new when redirectTo is not an allowed in-app path', async () => {
    useAccessToken.setState({ hasSession: true });
    serveRefresh(true);

    renderLogin('/login?redirectTo=https%3A%2F%2Fevil.example%2Fsteal');

    await waitFor(() => expect(history.replace).toHaveBeenCalledWith('/new'));
    expect(screen.queryByTestId('login-form')).toBeNull();
  });

  it('shows the form and clears caches when the hinted session is gone, with nothing on the console', async () => {
    useAccessToken.setState({ hasSession: true });
    const calls = serveRefresh(false);

    renderLogin('/login?redirectTo=%2Fprojects');

    await screen.findByTestId('login-form');
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['/api/auth/refreshToken']);
    expect(history.replace).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('makes no refresh call for a visitor with no session hint', async () => {
    const calls = serveRefresh(true);

    renderLogin('/login?redirectTo=%2Fprojects');

    expect(screen.getByTestId('login-form')).toBeTruthy();
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]);
    expect(history.replace).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps the form when the URL carries a sign-in error, even with a session hint', async () => {
    useAccessToken.setState({ hasSession: true });
    const calls = serveRefresh(true);

    renderLogin('/login?error=oauth_failed');

    expect(screen.getByTestId('login-form')).toBeTruthy();
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([]);
    expect(history.replace).not.toHaveBeenCalled();
  });

  it('leaves a session that is already live in memory alone: no resume, no cache teardown', async () => {
    useAccessToken.setState({ accessToken: 'live-access', hasSession: true });
    useUser.setState({ currentUser: signedInUser as never });
    const calls = serveRefresh(true);

    renderLogin('/login?redirectTo=%2Fprojects');

    expect(screen.getByTestId('login-form')).toBeTruthy();
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(clearClientCaches).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(history.replace).not.toHaveBeenCalled();
  });

  it('forwards when another tab signs in while the form is open', async () => {
    const calls = serveRefresh(true);
    renderLogin('/login?redirectTo=%2Fprojects');
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(signedInElsewhere(true));
    });

    await waitFor(() => expect(history.replace).toHaveBeenCalledWith('/projects'));
    expect(calls).toEqual(['/api/auth/refreshToken']);
  });

  it("forwards on a later sign-in in another tab after this tab's own resume found no session", async () => {
    useAccessToken.setState({ hasSession: true });
    const calls = serveRefresh(false);
    renderLogin('/login?redirectTo=%2Fprojects');
    await screen.findByTestId('login-form');
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['/api/auth/refreshToken']);

    const laterCalls = serveRefresh(true);
    act(() => {
      window.dispatchEvent(signedInElsewhere(true));
    });

    await waitFor(() => expect(history.replace).toHaveBeenCalledWith('/projects'));
    expect(laterCalls).toEqual(['/api/auth/refreshToken']);
  });

  it('ignores another tab signing out, and a sign-in while this tab is mid-MFA', async () => {
    const calls = serveRefresh(true);
    renderLogin('/login?redirectTo=%2Fprojects');
    await waitFor(() => expect(clearClientCaches).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(signedInElsewhere(false));
    });
    useAccessToken.setState({ accessToken: 'mfa-pending-token', mfaPending: true });
    act(() => {
      window.dispatchEvent(signedInElsewhere(true));
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    expect(history.replace).not.toHaveBeenCalled();
  });
});

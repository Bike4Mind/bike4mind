import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { clearClientCaches } from '@client/app/utils/clearClientCaches';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { Box } from '@mui/joy';
import {
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from '@tanstack/react-router';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { resetRefreshCoordinator } from '@client/app/utils/refreshCoordinator';
import { bootstrapSession, resetSessionBootstrap } from '@client/app/utils/sessionBootstrap';
import LoginPage from './login';

// A stand-in for MultiStepLogin that keeps the pieces of it these flows depend on, verbatim in
// shape: the "already logged in" effect, the sign-in error effect that strips `error` from the
// address, and finishLogin's store writes followed by applyRedirect.
vi.mock('@client/app/components/MultiStepLogin', async () => {
  const { useEffect } = await import('react');
  const { useRouter } = await import('@tanstack/react-router');
  const { applyRedirect } = await import('@client/app/utils/authRedirect');
  const { useUser: useUserStore } = await import('@client/app/contexts/UserContext');
  const { useAccessToken: useTokenStore } = await import('@client/app/hooks/useAccessToken');
  const MultiStepLoginStandIn = () => {
    const router = useRouter();
    const currentUser = useUserStore(s => s.currentUser);
    const accessToken = useTokenStore(s => s.accessToken);
    const isLoggedIn = !!currentUser && !!accessToken;
    useEffect(() => {
      if (isLoggedIn) {
        applyRedirect(router.history, new URLSearchParams(window.location.search).get('redirectTo'), '/new', true);
      }
    }, [isLoggedIn, router]);
    useEffect(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.get('error')) return;
      url.searchParams.delete('error');
      window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    }, []);
    const finishLogin = () => {
      useTokenStore.getState().setVerifiedSession('fresh-access');
      useUserStore.getState().setCurrentUser({ id: 'u1', username: 'rider' } as never);
      applyRedirect(router.history, new URLSearchParams(window.location.search).get('redirectTo'));
    };
    return <button data-testid="login-otc-verify-btn" onClick={finishLogin} />;
  };
  return { default: MultiStepLoginStandIn };
});
vi.mock('@client/app/hooks/data/settings', () => ({ usePublicConfig: () => ({ data: undefined }) }));
vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: { getState: () => ({ resetSettings: vi.fn() }) },
}));
vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

const appTheme = extendTheme({ ...getThemeConfig() });

/** The app's route shape for this flow: a root that wraps non-layout pages in a <main>, a public
 *  /login, and a guarded layout route whose beforeLoad awaits the session bootstrap. */
const buildRouter = () => {
  const rootRoute = createRootRoute({
    component: function Root() {
      const inLayout = useRouterState({ select: s => s.matches.some(m => m.routeId === '/_layout') });
      return inLayout ? (
        <Outlet />
      ) : (
        <Box component="main" sx={{ display: 'contents' }}>
          <Outlet />
        </Box>
      );
    },
  });
  const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage });
  const layoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: '_layout',
    beforeLoad: async () => {
      await bootstrapSession();
      if (!useUser.getState().currentUser) throw redirect({ to: '/login' });
    },
    component: () => <Outlet />,
  });
  const page = (path: string) =>
    createRoute({ getParentRoute: () => layoutRoute, path, component: () => <div data-testid={`page-${path}`} /> });
  return createRouter({
    routeTree: rootRoute.addChildren([loginRoute, layoutRoute.addChildren([page('/projects'), page('/new')])]),
    history: createBrowserHistory(),
  });
};

/** Mirrors TanStackRouterProvider: the router sits in a different wrapper once there is a user, so
 *  signing in remounts the whole route tree while the router still matches /login. */
const AppRouter = ({ router }: { router: ReturnType<typeof buildRouter> }) => {
  const currentUser = useUser(s => s.currentUser);
  const routerComponent = <RouterProvider router={router} />;
  return currentUser ? <>{routerComponent}</> : <div data-testid="signed-out-wrapper">{routerComponent}</div>;
};

describe('LoginPage in the router - a fresh sign-in', () => {
  beforeEach(() => {
    resetSessionBootstrap();
    resetRefreshCoordinator();
    useAccessToken.setState({ accessToken: null, hasSession: false, mfaPending: false, expired: false });
    useUser.setState({ currentUser: null });
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('lands on redirectTo and stays there', async () => {
    window.history.replaceState(null, '', '/login?redirectTo=%2Fprojects');
    const router = buildRouter();
    const seen: string[] = [];
    router.history.subscribe(({ location }) => seen.push(location.pathname));
    await act(() => router.load());
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CssVarsProvider theme={appTheme}>
          <AppRouter router={router} />
        </CssVarsProvider>
      </QueryClientProvider>
    );

    const verifyBtn = await screen.findByTestId('login-otc-verify-btn');
    vi.mocked(clearClientCaches).mockClear();
    fireEvent.click(verifyBtn);

    await waitFor(() =>
      expect(screen.queryByTestId('page-/projects') ?? screen.queryByTestId('page-/new')).toBeTruthy()
    );
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));
    expect(window.location.pathname).toBe('/projects');
    expect(seen).not.toContain('/new');
    expect(clearClientCaches).not.toHaveBeenCalled();
    expect(screen.getByTestId('page-/projects')).toBeTruthy();
  });

  it('keeps the form for a sign-in error even with a live cookie, after the error is stripped from the address', async () => {
    useAccessToken.setState({ hasSession: true });
    const calls: string[] = [];
    const realAdapter = api.defaults.adapter;
    api.defaults.adapter = ((config: InternalAxiosRequestConfig) => {
      calls.push(config.url ?? '');
      if (config.url === '/api/auth/refreshToken') {
        return Promise.resolve({
          data: { accessToken: 'fresh-access', user: { id: 'u1', username: 'rider' } },
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        } as AxiosResponse);
      }
      return Promise.reject(new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config));
    }) as AxiosAdapter;
    window.history.replaceState(null, '', '/login?error=session_expired&redirectTo=%2Fprojects');
    const router = buildRouter();
    const seen: string[] = [];
    router.history.subscribe(({ location }) => seen.push(location.pathname));
    await act(() => router.load());

    try {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <CssVarsProvider theme={appTheme}>
            <AppRouter router={router} />
          </CssVarsProvider>
        </QueryClientProvider>
      );

      await screen.findByTestId('login-otc-verify-btn');
      await waitFor(() => expect(clearClientCaches).toHaveBeenCalled());
      await act(() => new Promise(resolve => setTimeout(resolve, 50)));
      expect(window.location.search).toBe('?redirectTo=%2Fprojects');
      expect(calls).toEqual([]);
      expect(seen.filter(path => path !== '/login')).toEqual([]);
      expect(window.location.pathname).toBe('/login');
      expect(screen.getByTestId('login-otc-verify-btn')).toBeTruthy();
    } finally {
      api.defaults.adapter = realAdapter;
    }
  });
});

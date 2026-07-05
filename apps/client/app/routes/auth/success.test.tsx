import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Hoisted mocks (must be available inside vi.mock factory functions)
const {
  mockNavigate,
  mockRouterHistory,
  mockSetCurrentUser,
  mockSetAccessToken,
  mockSetRefreshToken,
  mockGetState,
  mockParseAuthParams,
  mockApplyRedirect,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRouterHistory: { push: vi.fn() },
  mockSetCurrentUser: vi.fn(),
  mockSetAccessToken: vi.fn(),
  mockSetRefreshToken: vi.fn(),
  mockGetState: vi.fn(() => ({ accessToken: null as string | null })),
  mockParseAuthParams: vi.fn(),
  mockApplyRedirect: vi.fn(),
}));

// mockSearch is only accessed lazily (inside () => mockSearch), so it doesn't
// need vi.hoisted - its value at call time is what matters.
let mockSearch: Record<string, unknown> = { redirectTo: '/new' };

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: mockRouterHistory }),
  useSearch: () => mockSearch,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ setCurrentUser: mockSetCurrentUser }),
}));

vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: Object.assign(() => ({ setAccessToken: mockSetAccessToken, setRefreshToken: mockSetRefreshToken }), {
    getState: mockGetState,
  }),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  resetRefreshPromise: vi.fn(),
}));

vi.mock('@client/app/utils/authParams', () => ({
  parseAuthParams: (...args: unknown[]) => mockParseAuthParams(...args),
}));

vi.mock('@client/app/utils/authRedirect', () => ({
  applyRedirect: (...args: unknown[]) => mockApplyRedirect(...args),
}));

const { mockTrackSignupConversion } = vi.hoisted(() => ({
  mockTrackSignupConversion: vi.fn(),
}));

vi.mock('@client/app/utils/signupConversion', () => ({
  trackSignupConversion: mockTrackSignupConversion,
}));

// Stub MUI Joy to avoid needing a CssVarsProvider in every test.
vi.mock('@mui/joy', () => ({
  Container: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Box: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Typography: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  CircularProgress: () => <div data-testid="spinner" />,
}));

import AuthSuccessPage from './success';

const TOKENS = { token: 'tok', refreshToken: 'ref', userId: 'u1', error: undefined };
const USER_DATA = { id: 'u1', name: 'Test User' };

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch = { redirectTo: '/new' };
  mockGetState.mockReturnValue({ accessToken: null });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => USER_DATA }));
});

describe('AuthSuccessPage', () => {
  it('sets tokens, fetches user, and redirects on a successful OAuth callback', async () => {
    mockParseAuthParams.mockReturnValue(TOKENS);

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockSetAccessToken).toHaveBeenCalledWith('tok');
    expect(mockSetRefreshToken).toHaveBeenCalledWith('ref');
    expect(mockSetCurrentUser).toHaveBeenCalledWith(USER_DATA);
    expect(mockNavigate).not.toHaveBeenCalled();
    // A routine login is not a signup - no conversion.
    expect(mockTrackSignupConversion).not.toHaveBeenCalled();
  });

  it('fires the signup conversion exactly once for a brand-new OAuth account', async () => {
    mockParseAuthParams.mockReturnValue({ ...TOKENS, isNewUser: true, signupMethod: 'google' });

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockTrackSignupConversion).toHaveBeenCalledExactlyOnceWith('google');
  });

  it('does not fire the signup conversion when the user fetch fails', async () => {
    mockParseAuthParams.mockReturnValue({ ...TOKENS, isNewUser: true, signupMethod: 'google' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, statusText: 'Unauthorized' }));

    render(<AuthSuccessPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error: 'auth_setup_failed' } })
    );
    expect(mockTrackSignupConversion).not.toHaveBeenCalled();
  });

  it('navigates to /login with the provider error code when params contain an error', async () => {
    mockParseAuthParams.mockReturnValue({ error: 'access_denied' });

    render(<AuthSuccessPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error: 'access_denied' } })
    );
    expect(mockApplyRedirect).not.toHaveBeenCalled();
  });

  it('navigates to /login with auth_setup_failed when the user fetch fails', async () => {
    mockParseAuthParams.mockReturnValue(TOKENS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, statusText: 'Unauthorized' }));

    render(<AuthSuccessPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error: 'auth_setup_failed' } })
    );
    expect(mockApplyRedirect).not.toHaveBeenCalled();
  });

  it('navigates to /login with missing_tokens when no tokens and no stored access token', async () => {
    mockParseAuthParams.mockReturnValue({});
    mockGetState.mockReturnValue({ accessToken: null });

    render(<AuthSuccessPage />);

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error: 'missing_tokens' } })
    );
    expect(mockApplyRedirect).not.toHaveBeenCalled();
  });

  it('redirects to destination (not error) when no tokens in URL but access token already in store', async () => {
    // Covers the React 18 concurrent-mode re-mount: hash already cleared by the
    // first mount, but auth succeeded and the token is in the Zustand store.
    mockParseAuthParams.mockReturnValue({});
    mockGetState.mockReturnValue({ accessToken: 'existing-tok' });

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('fires applyRedirect exactly once under React StrictMode (hasProcessed guard)', async () => {
    mockParseAuthParams.mockReturnValue(TOKENS);

    render(
      <React.StrictMode>
        <AuthSuccessPage />
      </React.StrictMode>
    );

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledTimes(1));
  });
});

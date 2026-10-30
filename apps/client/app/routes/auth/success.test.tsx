import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { FIRST_SIGNUP_SESSION_KEY } from '@client/app/utils/firstSignupSession';

// Hoisted mocks (must be available inside vi.mock factory functions)
const {
  mockNavigate,
  mockRouterHistory,
  mockSetCurrentUser,
  mockSetVerifiedSession,
  mockGetState,
  mockParseAuthParams,
  mockApplyRedirect,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockRouterHistory: { push: vi.fn() },
  mockSetCurrentUser: vi.fn(),
  mockSetVerifiedSession: vi.fn(),
  mockGetState: vi.fn(() => ({ accessToken: null as string | null })),
  mockParseAuthParams: vi.fn(),
  mockApplyRedirect: vi.fn(),
}));

// mockSearch / mockCurrentUser are only accessed lazily (inside the mock
// factories' arrow fns), so they don't need vi.hoisted - their value at call
// time is what matters.
let mockSearch: Record<string, unknown> = { redirectTo: '/new' };
let mockCurrentUser: { id: string } | null = null;

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({ history: mockRouterHistory }),
  useSearch: () => mockSearch,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: mockCurrentUser, setCurrentUser: mockSetCurrentUser }),
}));

vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: Object.assign(() => ({ setVerifiedSession: mockSetVerifiedSession }), {
    getState: mockGetState,
  }),
}));

vi.mock('@client/app/utils/refreshCoordinator', () => ({
  resetRefreshCoordinator: vi.fn(),
}));

vi.mock('@client/app/utils/sessionBootstrap', () => ({
  resetSessionBootstrap: vi.fn(),
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

type MfaChallengeOptions = {
  onComplete: (result: { accessToken: string; user: unknown }) => void;
  onCancel: (mode: 'verify' | 'setup') => void;
};
const { mockBeginMfa, mfaOptions } = vi.hoisted(() => ({
  mockBeginMfa: vi.fn(),
  mfaOptions: { current: null as MfaChallengeOptions | null },
}));

vi.mock('@client/app/hooks/useMfaChallenge', () => ({
  useMfaChallenge: (options: MfaChallengeOptions) => {
    mfaOptions.current = options;
    return { begin: mockBeginMfa, modalProps: {} };
  },
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  usePublicConfig: () => ({ data: { allowTrustedDevices: true } }),
}));

vi.mock('@client/app/components/common/MFAModal', () => ({ default: () => null }));

import AuthSuccessPage from './success';

const TOKENS = { token: 'tok', userId: 'u1', error: undefined };
const USER_DATA = { id: 'u1', name: 'Test User' };

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockSearch = { redirectTo: '/new' };
  mockCurrentUser = null;
  mockGetState.mockReturnValue({ accessToken: null });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => USER_DATA }));
});

describe('AuthSuccessPage', () => {
  it('sets tokens, fetches user, and redirects on a successful OAuth callback', async () => {
    mockParseAuthParams.mockReturnValue(TOKENS);

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockSetVerifiedSession).toHaveBeenCalledWith('tok');
    expect(mockSetCurrentUser).toHaveBeenCalledWith(USER_DATA);
    expect(mockNavigate).not.toHaveBeenCalled();
    // A routine login is not a signup - no conversion.
    expect(mockTrackSignupConversion).not.toHaveBeenCalled();
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });

  it('marks a fresh SAML session without recording an ad conversion', async () => {
    mockParseAuthParams.mockReturnValue({ ...TOKENS, firstSignupSession: true });
    render(<AuthSuccessPage />);
    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string).userId).toBe(USER_DATA.id);
    expect(mockTrackSignupConversion).not.toHaveBeenCalled();
  });

  it('fires the signup conversion exactly once for a brand-new OAuth account', async () => {
    mockParseAuthParams.mockReturnValue({ ...TOKENS, isNewUser: true, signupMethod: 'google' });

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockTrackSignupConversion).toHaveBeenCalledExactlyOnceWith('google');
    expect(JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string).userId).toBe(USER_DATA.id);
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

  it('refuses to switch identity when already signed in as a different user', async () => {
    // #134: navigating an already-signed-in browser to /auth/success#token=<other
    // account> must not adopt the other user's session.
    mockCurrentUser = { id: 'other-user' };
    mockParseAuthParams.mockReturnValue(TOKENS); // token for u1

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
    expect(mockSetVerifiedSession).not.toHaveBeenCalled();
    expect(mockSetCurrentUser).not.toHaveBeenCalled();
  });

  it('adopts the token on a re-login as the same user', async () => {
    mockCurrentUser = { id: 'u1' };
    mockParseAuthParams.mockReturnValue(TOKENS); // token for u1

    render(<AuthSuccessPage />);

    await waitFor(() => expect(mockSetVerifiedSession).toHaveBeenCalledWith('tok'));
    expect(mockSetCurrentUser).toHaveBeenCalledWith(USER_DATA);
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

  describe('second-factor handoff', () => {
    const MFA_PARAMS = { userId: 'u1', mfa: { token: 'pending', mode: 'verify', passkeyAvailable: true } };

    it('opens the MFA challenge with the pending token instead of adopting a session', async () => {
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);

      render(<AuthSuccessPage />);

      await waitFor(() =>
        expect(mockBeginMfa).toHaveBeenCalledWith({
          userId: 'u1',
          mfaToken: 'pending',
          mode: 'verify',
          passkeyAvailable: true,
        })
      );
      expect(mockSetVerifiedSession).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mockApplyRedirect).not.toHaveBeenCalled();
    });

    it('sets the user, fires a pending signup conversion and redirects once MFA completes', async () => {
      mockParseAuthParams.mockReturnValue({ ...MFA_PARAMS, isNewUser: true, signupMethod: 'github' });
      render(<AuthSuccessPage />);
      await waitFor(() => expect(mockBeginMfa).toHaveBeenCalled());

      mfaOptions.current?.onComplete({ accessToken: 'full', user: USER_DATA });

      expect(mockSetCurrentUser).toHaveBeenCalledWith(USER_DATA);
      expect(mockTrackSignupConversion).toHaveBeenCalledExactlyOnceWith('github');
      expect(JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string).userId).toBe(USER_DATA.id);
      expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new');
    });

    it.each([
      ['verify', 'mfa_required'],
      ['setup', 'mfa_setup_required'],
    ] as const)('sends an abandoned %s challenge back to /login with %s', async (mode, error) => {
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);
      render(<AuthSuccessPage />);
      await waitFor(() => expect(mockBeginMfa).toHaveBeenCalled());

      mfaOptions.current?.onCancel(mode);

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error, redirectTo: '/new' } });
    });

    it('omits redirectTo from the /login search when the handoff carried none', async () => {
      mockSearch = {};
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);
      render(<AuthSuccessPage />);
      await waitFor(() => expect(mockBeginMfa).toHaveBeenCalled());

      mfaOptions.current?.onCancel('verify');

      expect(mockNavigate).toHaveBeenCalledWith({ to: '/login', search: { error: 'mfa_required' } });
    });

    it('returns a still-signed-in user to their destination when the challenge is abandoned', async () => {
      mockGetState.mockReturnValue({ accessToken: null, hasSession: true });
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);
      render(<AuthSuccessPage />);
      await waitFor(() => expect(mockBeginMfa).toHaveBeenCalled());

      mfaOptions.current?.onCancel('verify');

      expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('runs the challenge for the same user, since it mints a fresh session', async () => {
      mockCurrentUser = { id: 'u1' };
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);

      render(<AuthSuccessPage />);

      await waitFor(() => expect(mockBeginMfa).toHaveBeenCalled());
      expect(mockApplyRedirect).not.toHaveBeenCalled();
    });

    it('refuses a handoff for a different user than the signed-in one', async () => {
      mockCurrentUser = { id: 'other' };
      mockParseAuthParams.mockReturnValue(MFA_PARAMS);

      render(<AuthSuccessPage />);

      await waitFor(() => expect(mockApplyRedirect).toHaveBeenCalledWith(mockRouterHistory, '/new'));
      expect(mockBeginMfa).not.toHaveBeenCalled();
    });
  });
});

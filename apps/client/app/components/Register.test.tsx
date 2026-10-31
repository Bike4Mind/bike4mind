import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { FIRST_SIGNUP_SESSION_KEY } from '@client/app/utils/firstSignupSession';

const mockLogEvent = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: mockLogEvent }) }));

// Data/context deps are stubbed; the real @mui/joy Checkbox + Link and react-hook-form render so we
// can assert the anchors the registration consent checkbox exposes. Open registration is enabled
// (allowOpenRegistration: true, not loading) so the form renders instead of the config gate.
type MfaHookOptions = {
  onComplete: (result: unknown) => void;
  onCancel?: (mode: 'verify' | 'setup') => void;
};

const mocks = vi.hoisted(() => ({
  setCurrentUser: vi.fn(),
  setAccessToken: vi.fn(),
  setVerifiedSession: vi.fn(),
  sendOTC: vi.fn(),
  formToken: { data: 'form-tok-1' as string | undefined, refetch: vi.fn() },
  verifyOTC: vi.fn(),
  startOAuthSignIn: vi.fn(),
  mutateAsync: vi.fn(),
  navigate: vi.fn(),
  allowOpenRegistration: true,
  trackSignupConversion: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
  mfa: { options: null as MfaHookOptions | null, begin: vi.fn() },
}));

vi.mock('@client/app/hooks/data/auth', async () => {
  const { useState } = await vi.importActual<typeof import('react')>('react');
  return {
    useSignupBotFields: () => {
      const [honeypot, setHoneypot] = useState('');
      return {
        botFields: { formToken: mocks.formToken.data, formExtra: honeypot },
        honeypotProps: { value: honeypot, onChange: setHoneypot },
      };
    },
    useSendOTC: () => ({ mutateAsync: mocks.sendOTC, isPending: false }),
    useVerifyOTC: () => ({ mutateAsync: mocks.verifyOTC, isPending: false }),
    useStartOAuthSignIn: () => mocks.startOAuthSignIn,
  };
});
vi.mock('@client/app/hooks/useMfaChallenge', () => ({
  useMfaChallenge: (options: MfaHookOptions) => {
    mocks.mfa.options = options;
    return { begin: mocks.mfa.begin, modalProps: { open: false } };
  },
}));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useVerifyMFA: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useSetupMFA: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
  useVerifyMFASetup: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
vi.mock('@client/app/hooks/data/passkeys', () => ({
  useVerifyPasskeyMFA: () => ({ mutateAsync: vi.fn(), isPending: false }),
  describePasskeyMfaError: () => 'Passkey verification failed',
  passkeysSupported: () => false,
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ setCurrentUser: mocks.setCurrentUser, currentUser: null }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: Object.assign(() => ({ setAccessToken: mocks.setAccessToken }), {
    getState: () => ({ setVerifiedSession: mocks.setVerifiedSession }),
  }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: {} }),
}));
vi.mock('@client/app/utils/authRedirect', () => ({
  applyRedirect: vi.fn(),
  appendRedirectTo: (url: string) => url,
}));
vi.mock('@client/app/utils/sessionBootstrap', () => ({ resetSessionBootstrap: vi.fn() }));
vi.mock('@client/app/utils/refreshCoordinator', () => ({ resetRefreshCoordinator: vi.fn() }));
vi.mock('@client/app/utils/signupConversion', () => ({ trackSignupConversion: mocks.trackSignupConversion }));
vi.mock('@client/app/hooks/useCommonStyles', () => ({
  useCommonStyles: () => ({ inputStyles: {}, dividerStyles: {} }),
}));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useBrandingSettings: () => ({}),
  usePublicConfig: () => ({ data: { allowOpenRegistration: mocks.allowOpenRegistration }, isLoading: false }),
}));
vi.mock('./common/MFAModal', () => ({ default: () => null }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

import Register from './Register';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderRegister = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <Register />
    </CssVarsProvider>
  );

describe('Register', () => {
  beforeEach(() => {
    mocks.allowOpenRegistration = true;
  });

  it.each([
    ['register-google-btn', '/api/auth/google'],
    ['register-github-btn', '/api/auth/github'],
    ['register-okta-btn', '/api/auth/okta'],
  ])('starts the provider sign-up through the challenge-aware hook from %s', async (testId, startUrl) => {
    mocks.startOAuthSignIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderRegister();
    await user.click(screen.getByTestId(testId));
    expect(mocks.startOAuthSignIn).toHaveBeenCalledWith(startUrl);
  });

  it('shows the challenge error and stays on the page when the sign-up cannot start', async () => {
    mocks.startOAuthSignIn.mockRejectedValue(new Error('Could not complete the verification check.'));
    const user = userEvent.setup();
    renderRegister();
    await user.click(screen.getByTestId('register-google-btn'));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Could not complete the verification check.'));
  });

  // Regression guard for #59: the ToS/AUP/Privacy links in the acceptance-checkbox label must
  // point at the right policy pages and open in a new tab. (The underlying bug - clicks landing
  // on the checkbox's transparent input overlay instead of the anchor - is a visual stacking-order
  // issue jsdom cannot reproduce, so it is verified in a browser, not here. See the fix: each Link
  // is raised above the overlay via the shared CHECKBOX_LABEL_LINK_SX.)
  it('renders the policy links with the correct href, new-tab target, and rel', () => {
    renderRegister();

    const cases: Array<[string, string]> = [
      ['Terms of Service', ExternalLinks.terms],
      ['Acceptable Use Policy', ExternalLinks.acceptableUse],
      ['Privacy Policy', ExternalLinks.privacy],
    ];
    for (const [name, href] of cases) {
      const link = screen.getByRole('link', { name });
      expect(link).toHaveAttribute('href', href);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});

describe('Register - field errors and rate limiting', () => {
  it('ties the inline email error to the input with aria-describedby and role=alert', async () => {
    const user = userEvent.setup();
    renderRegister();

    const input = within(screen.getByTestId('register-email-input')).getByRole('textbox');
    await user.type(input, 'not-an-email');
    await user.tab();

    const alert = screen.getByTestId('register-email-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('auth.fieldErrors.invalidEmail');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
  });

  it('ties the inline username error to the input with aria-describedby and role=alert', async () => {
    const user = userEvent.setup();
    renderRegister();

    const input = within(screen.getByTestId('register-username-input')).getByRole('textbox');
    await user.type(input, 'bad name!');
    await user.tab();

    const alert = screen.getByTestId('register-username-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('auth.fieldErrors.invalidUsername');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
  });

  it('shows an alert and disables Continue with a countdown when the code request is rate limited', async () => {
    const user = userEvent.setup();
    mocks.sendOTC.mockRejectedValueOnce({
      message: 'Rate limit exceeded. Try again in 573 seconds',
      code: 'CLIENT_ERROR_429',
      retryAfterSeconds: 573,
    });
    renderRegister();

    await user.type(within(screen.getByTestId('register-username-input')).getByRole('textbox'), 'newbie');
    await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
    await user.click(within(screen.getByTestId('register-aup-tos-checkbox')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('register-age-checkbox')).getByRole('checkbox'));
    await user.click(screen.getByTestId('register-submit-btn'));

    const alert = await screen.findByTestId('register-rate-limit-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('register-submit-btn')).toBeDisabled();
    expect(screen.getByTestId('register-submit-btn')).toHaveTextContent('auth.retryIn');
  });
});

describe('Register - second-factor handoff', () => {
  const submitCode = async (user: ReturnType<typeof userEvent.setup>) => {
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
    await user.type(within(screen.getByTestId('register-username-input')).getByRole('textbox'), 'newbie');
    await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
    await user.click(within(screen.getByTestId('register-aup-tos-checkbox')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('register-age-checkbox')).getByRole('checkbox'));
    await user.click(screen.getByTestId('register-submit-btn'));
    const otcInput = within(await screen.findByTestId('register-otc-input')).getByRole('textbox');
    await user.type(otcInput, '12345678');
    await user.click(screen.getByTestId('register-verify-btn'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.mfa.options = null;
    mocks.allowOpenRegistration = true;
  });

  it('allows invite-only email signup and preserves the invite across code retries', async () => {
    mocks.allowOpenRegistration = false;
    mocks.verifyOTC
      .mockRejectedValueOnce({ message: 'Try again', pendingToken: 'ptok-retry' })
      .mockResolvedValueOnce({ user: { id: 'invited-user' }, accessToken: 'full' });
    const user = userEvent.setup();
    renderRegister();

    expect(screen.getByTestId('register-form')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(screen.getByText('Google')).not.toBeVisible();
    await user.type(within(screen.getByTestId('register-invite-input')).getByRole('textbox'), ' INVITE123 ');
    await submitCode(user);
    await waitFor(() => expect(mocks.verifyOTC).toHaveBeenCalledTimes(1));
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(expect.objectContaining({ inviteCode: 'INVITE123' }));
    await user.click(screen.getByTestId('register-verify-btn'));
    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalledWith({ id: 'invited-user' }));
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(
      expect.objectContaining({ inviteCode: 'INVITE123', pendingToken: 'ptok-retry' })
    );
  });

  it('ignores a second Resend click while a resend is still in flight', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finishResend: (value: { pendingToken: string }) => void = () => {};
      mocks.sendOTC
        .mockResolvedValueOnce({ pendingToken: 'ptok-1' })
        .mockReturnValueOnce(new Promise(resolve => (finishResend = resolve)));
      renderRegister();
      await user.type(within(screen.getByTestId('register-username-input')).getByRole('textbox'), 'newbie');
      await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
      await user.click(within(screen.getByTestId('register-aup-tos-checkbox')).getByRole('checkbox'));
      await user.click(within(screen.getByTestId('register-age-checkbox')).getByRole('checkbox'));
      await user.click(screen.getByTestId('register-submit-btn'));
      await screen.findByTestId('register-resend-btn');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31000);
      });
      await user.dblClick(screen.getByTestId('register-resend-btn'));
      expect(mocks.sendOTC).toHaveBeenCalledTimes(2);
      await act(async () => finishResend({ pendingToken: 'ptok-2' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('requires an invite before sending a code on an invite-only instance', async () => {
    mocks.allowOpenRegistration = false;
    renderRegister();
    const user = userEvent.setup();
    await user.type(within(screen.getByTestId('register-username-input')).getByRole('textbox'), 'newbie');
    await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
    await user.click(within(screen.getByTestId('register-aup-tos-checkbox')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('register-age-checkbox')).getByRole('checkbox'));
    expect(screen.getByTestId('register-submit-btn')).toBeDisabled();
    expect(mocks.sendOTC).not.toHaveBeenCalled();
  });

  it('sends an invite-less visitor to the waitlist with the email they typed', async () => {
    mocks.allowOpenRegistration = false;
    renderRegister();
    const user = userEvent.setup();
    await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
    await user.click(screen.getByTestId('register-join-waitlist-link'));

    expect(mocks.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/subscribe', search: { source: 'register_signup_closed' } })
    );
    const { state } = mocks.navigate.mock.calls.at(-1)[0];
    expect(state({})).toEqual({ waitlistEmail: 'new@test.com' });
  });

  it('hides the waitlist link when registration is open', () => {
    renderRegister();
    expect(screen.queryByTestId('register-join-waitlist-link')).not.toBeInTheDocument();
  });

  it('marks a freshly registered account first session before entering the app', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({ user: { id: 'new-user' }, accessToken: 'full' });
    renderRegister();
    await submitCode(userEvent.setup());
    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalledWith({ id: 'new-user' }));
    expect(JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string).userId).toBe('new-user');
    expect(mocks.setVerifiedSession).toHaveBeenCalledWith('full');
  });

  it('does not mark an existing account login as a first session', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({ id: 'existing-user', accessToken: 'full' });
    renderRegister();
    await submitCode(userEvent.setup());
    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalled());
    expect(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY)).toBeNull();
  });

  it('begins a verify challenge when the account already exists and demands MFA', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({
      mfaRequired: true,
      userId: 'u1',
      accessToken: 'pending-tok',
      passkeyAvailable: true,
    });
    renderRegister();

    await submitCode(userEvent.setup());

    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalledTimes(1));
    expect(mocks.mfa.begin).toHaveBeenCalledWith({
      userId: 'u1',
      mfaToken: 'pending-tok',
      mode: 'verify',
      passkeyAvailable: true,
    });
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();
  });

  it('begins a setup challenge when the response is mfaSetupRequired', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({ mfaSetupRequired: true, userId: 'u1', accessToken: 'pending-tok' });
    renderRegister();

    await submitCode(userEvent.setup());

    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalledTimes(1));
    expect(mocks.mfa.begin).toHaveBeenCalledWith({ userId: 'u1', mfaToken: 'pending-tok', mode: 'setup' });
  });

  it('logs policies_accepted once a new account is created', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({ user: { id: 'new-1', email: 'new@test.com' }, accessToken: 'atk' });
    renderRegister();

    await submitCode(userEvent.setup());

    await waitFor(() =>
      expect(mockLogEvent).toHaveBeenCalledWith({ type: 'policies_accepted', metadata: { path: 'registration' } })
    );
  });

  it('sets the current user from the completed challenge', () => {
    renderRegister();

    mocks.mfa.options!.onComplete({ accessToken: 'full', user: { id: 'u1' } });

    expect(mocks.setCurrentUser).toHaveBeenCalledWith({ id: 'u1' });
  });

  it.each([
    ['verify', 'error'],
    ['setup', 'info'],
  ] as const)('returns to the form with a %s notice when the challenge is cancelled', async (mode, toastKind) => {
    mocks.verifyOTC.mockResolvedValueOnce({ mfaRequired: true, userId: 'u1', accessToken: 'pending-tok' });
    renderRegister();
    await submitCode(userEvent.setup());
    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalled());
    expect(screen.queryByTestId('register-form')).not.toBeInTheDocument();

    act(() => mocks.mfa.options!.onCancel!(mode));

    expect(await screen.findByTestId('register-form')).toBeInTheDocument();
    expect(mocks.toast[toastKind]).toHaveBeenCalledTimes(1);
  });
});

describe('Register - signup bot checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.formToken.data = 'form-tok-1';
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
  });

  const fillAndSubmit = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(within(screen.getByTestId('register-username-input')).getByRole('textbox'), 'newbie');
    await user.type(within(screen.getByTestId('register-email-input')).getByRole('textbox'), 'new@test.com');
    await user.click(within(screen.getByTestId('register-aup-tos-checkbox')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('register-age-checkbox')).getByRole('checkbox'));
    await user.click(screen.getByTestId('register-submit-btn'));
    await screen.findByTestId('register-otc-input');
  };

  it('sends the form token and an empty honeypot value with the initial code request', async () => {
    renderRegister();
    await fillAndSubmit(userEvent.setup());
    expect(mocks.sendOTC).toHaveBeenCalledWith({ email: 'new@test.com', formToken: 'form-tok-1', formExtra: '' });
  });

  it('submits immediately without a token when none is loaded', async () => {
    mocks.formToken.data = undefined;
    renderRegister();
    await fillAndSubmit(userEvent.setup());
    expect(mocks.formToken.refetch).not.toHaveBeenCalled();
    expect(mocks.sendOTC).toHaveBeenCalledWith({ email: 'new@test.com', formToken: undefined, formExtra: '' });
  });
});

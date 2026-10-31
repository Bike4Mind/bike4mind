import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CURRENT_POLICY_VERSION, USERNAME_RULES_MESSAGE } from '@bike4mind/common';
import en from '@client/app/locales/en.json';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { FIRST_SIGNUP_SESSION_KEY } from '@client/app/utils/firstSignupSession';
import { useCookieSettings } from '@client/app/components/CookieConsentBanner';

const mockLogEvent = vi.hoisted(() => vi.fn());
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: mockLogEvent }) }));
import MultiStepLogin from './MultiStepLogin';

type MfaHookOptions = {
  onComplete: (result: unknown) => void;
  onCancel?: (mode: 'verify' | 'setup') => void;
};

// Factory-safe mock handles (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  sendOTC: vi.fn(),
  formToken: { data: 'form-tok-1' as string | undefined, refetch: vi.fn() },
  verifyOTC: vi.fn(),
  startOAuthSignIn: vi.fn(),
  setCurrentUser: vi.fn(),
  trackSignupConversion: vi.fn(),
  applyRedirect: vi.fn(),
  navigate: vi.fn(),
  // Mutable so the "already logged in" tests can vary the session state. Not reset by
  // vi.clearAllMocks() (it only touches mock fns) - each describe's beforeEach resets these.
  userState: { currentUser: null as unknown },
  accessTokenState: {
    accessToken: null as string | null,
    setVerifiedSession: vi.fn(),
    resetTokens: vi.fn(),
    setMfaPendingTokens: vi.fn(),
    forceLogoutTokens: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
  mfa: { options: null as MfaHookOptions | null, begin: vi.fn() },
  // Empty for every suite but the Cookie settings one, so the legal sentence stays hidden and
  // the checkbox's Privacy Policy link is the only one on the page.
  websiteUrl: '',
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
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ setCurrentUser: mocks.setCurrentUser, currentUser: mocks.userState.currentUser }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  // Apply the selector so `useAccessToken(s => s.accessToken)` returns the token, not the
  // whole state object; bare `getState()` calls still get the full state.
  useAccessToken: Object.assign(
    (selector?: (s: typeof mocks.accessTokenState) => unknown) =>
      selector ? selector(mocks.accessTokenState) : mocks.accessTokenState,
    { getState: () => mocks.accessTokenState }
  ),
}));
vi.mock('@client/app/hooks/useMfaChallenge', () => ({
  useMfaChallenge: (options: MfaHookOptions) => {
    mocks.mfa.options = options;
    return { begin: mocks.mfa.begin, modalProps: { open: false } };
  },
}));
vi.mock('./common/MFAModal', () => ({ default: () => null }));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useVerifyMFA: () => ({ mutateAsync: vi.fn() }),
  useSetupMFA: () => ({ mutateAsync: vi.fn() }),
  useVerifyMFASetup: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@client/app/hooks/data/passkeys', () => ({
  useVerifyPasskeyMFA: () => ({ mutateAsync: vi.fn(), isPending: false }),
  describePasskeyMfaError: () => 'Passkey verification failed',
  passkeysSupported: () => false,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mocks.navigate,
  useRouter: () => ({ history: {} }),
}));
// finishLogin calls applyRedirect(router.history, ...); stub it so the empty history is inert.
vi.mock('@client/app/utils/authRedirect', () => ({
  applyRedirect: mocks.applyRedirect,
  appendRedirectTo: (url: string) => url,
}));
vi.mock('@client/app/utils/refreshCoordinator', () => ({ resetRefreshCoordinator: vi.fn() }));
vi.mock('@client/app/utils/signupConversion', () => ({ trackSignupConversion: mocks.trackSignupConversion }));
vi.mock('@client/app/hooks/useCommonStyles', () => ({
  useCommonStyles: () => ({ inputStyles: {}, dividerStyles: {} }),
}));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useBrandingSettings: () => ({}),
  usePublicConfig: () => ({ data: { allowTrustedDevices: true } }),
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey?: string }) => i18nKey ?? null,
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
// A getter, because WEBSITE_URL is a module constant and the suite needs it both ways.
vi.mock('@client/config/general', async importOriginal => ({
  ...(await importOriginal<typeof import('@client/config/general')>()),
  get WEBSITE_URL() {
    return mocks.websiteUrl;
  },
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderLogin = (props: React.ComponentProps<typeof MultiStepLogin> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MultiStepLogin {...props} />
    </CssVarsProvider>
  );

const textboxIn = (testId: string) => within(screen.getByTestId(testId)).getByRole('textbox');
const checkboxIn = (testId: string) => within(screen.getByTestId(testId)).getByRole('checkbox');

// useJoinWaitlist passes the email as a history-state updater, never in the query string.
const expectWaitlistNavigation = (source: string, email: string | undefined) => {
  expect(mocks.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: '/subscribe', search: { source }, state: expect.any(Function) })
  );
  const { state } = mocks.navigate.mock.calls.at(-1)[0];
  expect(state({ key: 'k' })).toEqual({ key: 'k', waitlistEmail: email });
};

// Drives the flow from the email step to the register-username step (email -> code ->
// registrationRequired). Assumes mocks.verifyOTC's FIRST call resolves registrationRequired.
const advanceToUsernameStep = async (user: ReturnType<typeof userEvent.setup>, email = 'new@test.com') => {
  await user.type(textboxIn('login-email-input'), email);
  await user.click(screen.getByTestId('login-continue-btn'));
  const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
  await user.type(otcInput, '12345678');
  await user.click(screen.getByTestId('login-verify-btn'));
  await screen.findByTestId('login-register-username-input');
};

// The AUP/ToS + 18+ checkboxes gate the Create account button.
const acceptInlinePolicies = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(checkboxIn('login-register-aup-tos-checkbox'));
  await user.click(checkboxIn('login-register-age-checkbox'));
};

describe('MultiStepLogin — inline registration (new-user branch)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
    // Strategy check for a passwordless email - no SSO redirect.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requiresRedirect: false }),
    }) as unknown as typeof fetch;
  });

  it('links invite-only visitors to the registration form', async () => {
    renderLogin({ enableRegister: false });
    expect(screen.getByTestId('signup-text')).toHaveTextContent('Have an invite code?');
    await userEvent.setup().click(screen.getByTestId('signup-text'));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/register', search: undefined });
  });

  it('offers invite-only visitors the waitlist with their typed email', async () => {
    const user = userEvent.setup();
    renderLogin({ enableRegister: false });

    await user.type(textboxIn('login-email-input'), ' new@test.com ');
    await user.click(screen.getByTestId('login-join-waitlist-link'));

    expectWaitlistNavigation('login_signup_closed', 'new@test.com');
  });

  it('hides the waitlist link when registration is open', () => {
    renderLogin({ enableRegister: true });
    expect(screen.queryByTestId('login-join-waitlist-link')).not.toBeInTheDocument();
  });

  it('turns an email-code signup refusal into a waitlist action carrying the verified email', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      registrationAllowed: false,
      email: 'new@test.com',
      pendingToken: 'ptok-closed',
    });
    renderLogin({ enableRegister: false });

    await user.type(textboxIn('login-email-input'), 'new@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));
    await user.type(within(await screen.findByTestId('login-otc-input')).getByRole('textbox'), '12345678');
    await user.click(screen.getByTestId('login-verify-btn'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('auth.registrationClosed', expect.anything()));
    const [, options] = mocks.toast.error.mock.calls[0];
    expect(options.action.label).toBe('auth.joinWaitlist');
    options.action.onClick();
    expectWaitlistNavigation('login_signup_closed', 'new@test.com');
  });

  it('lets keyboard users open invite-only registration', async () => {
    const user = userEvent.setup();
    renderLogin({ enableRegister: false });
    const signup = screen.getByTestId('signup-text');
    expect(signup.tagName).toBe('BUTTON');
    expect(signup).toHaveAttribute('type', 'button');
    for (let tabCount = 0; tabCount < 10 && document.activeElement !== signup; tabCount += 1) {
      await user.tab();
    }
    expect(signup).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/register', search: undefined });
    expect(mocks.sendOTC).not.toHaveBeenCalled();
  });

  it('hydrates currentUser with a FLAT user (not the nested {user} wrapper) after inline registration', async () => {
    const user = userEvent.setup();
    // 1st verify (code) -> email has no account yet; 2nd verify (with username) -> registration.
    mocks.verifyOTC
      .mockResolvedValueOnce({ registrationRequired: true, email: 'new@test.com', pendingToken: 'ptok-2' })
      .mockResolvedValueOnce({
        // Server returns the user NESTED under `user` for registration (unlike the flat login shape).
        user: { id: 'new-1', email: 'new@test.com', username: 'newbie', tags: [] },
        accessToken: 'atk',
        refreshToken: 'rtk',
      });

    renderLogin();

    // Steps 1-2: email -> code -> registrationRequired; step 3: username + acceptance -> create
    await advanceToUsernameStep(user);
    await user.type(textboxIn('login-register-username-input'), 'newbie');
    await acceptInlinePolicies(user);
    await user.click(screen.getByTestId('login-register-username-btn'));

    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalled());

    const arg = mocks.setCurrentUser.mock.calls[0][0];
    // Regression guard: the user must be flattened, NOT the { user, accessToken } wrapper.
    expect(arg).toMatchObject({
      id: 'new-1',
      email: 'new@test.com',
      username: 'newbie',
      accessToken: 'atk',
    });
    expect(arg).not.toHaveProperty('user');
    expect(mocks.accessTokenState.setVerifiedSession).toHaveBeenCalledWith('atk');
    // The inline step must thread the abuse-gate fields into the verify call;
    // without them the server rejects every inline registration.
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(
      expect.objectContaining({
        username: 'newbie',
        pendingToken: 'ptok-2',
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      })
    );
    // Ad-conversion signal fires exactly once for the freshly created account.
    expect(mocks.trackSignupConversion).toHaveBeenCalledTimes(1);
    expect(mockLogEvent).toHaveBeenCalledWith({ type: 'policies_accepted', metadata: { path: 'inline_registration' } });
    expect(JSON.parse(localStorage.getItem(FIRST_SIGNUP_SESSION_KEY) as string).userId).toBe('new-1');
  });

  it('keeps Create account disabled until BOTH acceptance checkboxes are checked', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });

    renderLogin();
    await advanceToUsernameStep(user);
    await user.type(textboxIn('login-register-username-input'), 'newbie');

    const createBtn = screen.getByTestId('login-register-username-btn');
    expect(createBtn).toBeDisabled();

    await user.click(checkboxIn('login-register-aup-tos-checkbox'));
    expect(createBtn).toBeDisabled();

    await user.click(checkboxIn('login-register-age-checkbox'));
    expect(createBtn).toBeEnabled();
  });

  it('blocks form submission (Enter-key bypass) while the acceptance checkboxes are unchecked', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });

    renderLogin();
    await advanceToUsernameStep(user);
    const usernameInput = textboxIn('login-register-username-input');
    await user.type(usernameInput, 'newbie');

    // Enter-key implicit submission can bypass a disabled submit button in some browsers,
    // and acceptedPolicyVersion is sent unconditionally - submit the form directly to
    // exercise the handler-level acceptance guard.
    fireEvent.submit(usernameInput.closest('form')!);

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    // Only the code-verify call happened - no registration attempt without acceptance.
    expect(mocks.verifyOTC).toHaveBeenCalledTimes(1);
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();
  });

  it('shows the username rules inline and makes no server call for an invalid username', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });

    renderLogin();
    await advanceToUsernameStep(user);
    await user.type(textboxIn('login-register-username-input'), '---');
    await user.click(checkboxIn('login-register-aup-tos-checkbox'));
    await user.click(checkboxIn('login-register-age-checkbox'));
    await user.click(screen.getByTestId('login-register-username-btn'));

    expect(await screen.findByTestId('login-register-username-error')).toHaveTextContent(USERNAME_RULES_MESSAGE);
    expect(mocks.verifyOTC).toHaveBeenCalledTimes(1);
  });

  it('retries with the RE-ISSUED pending token after a failed registration (nonce rotation)', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC
      .mockResolvedValueOnce({ registrationRequired: true, email: 'new@test.com', pendingToken: 'ptok-2' })
      // Registration failure (e.g. username taken) - the server rotated the nonce and re-issued;
      // useVerifyOTC surfaces the fresh token on the thrown error.
      .mockRejectedValueOnce({ message: 'This username is already registered', pendingToken: 'ptok-3' })
      .mockResolvedValueOnce({
        user: { id: 'new-1', email: 'new@test.com', username: 'newbie2', tags: [] },
        accessToken: 'atk',
        refreshToken: 'rtk',
      });

    renderLogin();
    await advanceToUsernameStep(user);
    await user.type(textboxIn('login-register-username-input'), 'newbie');
    await acceptInlinePolicies(user);
    await user.click(screen.getByTestId('login-register-username-btn'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('This username is already registered'));
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();

    // Retry with a different username: MUST carry the re-issued token - the original 'ptok-2'
    // no longer matches the rotated server-side nonce and would fail as "Invalid code."
    const usernameInput = textboxIn('login-register-username-input');
    await user.clear(usernameInput);
    await user.type(usernameInput, 'newbie2');
    await user.click(screen.getByTestId('login-register-username-btn'));

    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalled());
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(
      expect.objectContaining({ username: 'newbie2', pendingToken: 'ptok-3' })
    );
  });

  // Regression guard for #59: the ToS/AUP/Privacy links in the acceptance-checkbox label must
  // point at the right policy pages and open in a new tab. (The underlying bug - clicks landing
  // on the checkbox's transparent input overlay instead of the anchor - is a visual stacking-order
  // issue jsdom cannot reproduce, so it is verified in a browser, not here. See the fix: each Link
  // is raised above the overlay (which is zIndex: 1) with sx={{ position: 'relative', zIndex: 2 }}.)
  it('renders the policy links with the correct href, new-tab target, and rel', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });

    renderLogin();
    await advanceToUsernameStep(user);

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

  it('puts the numeric keypad and one-time-code hints on the code <input> itself', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(textboxIn('login-email-input'), 'new@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));

    const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
    expect(otcInput).toHaveAttribute('inputmode', 'numeric');
    expect(otcInput).toHaveAttribute('autocomplete', 'one-time-code');
  });

  it('takes an 8-digit code, and a legacy 6-digit one, but not a partial code', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });
    renderLogin();

    await user.type(textboxIn('login-email-input'), 'new@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));

    const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
    expect(otcInput).toHaveAttribute('placeholder', '00000000');
    const verifyBtn = screen.getByTestId('login-verify-btn');

    await user.click(otcInput);
    await user.paste('1234-5678 9');
    expect(otcInput).toHaveValue('12345678');
    expect(verifyBtn).not.toBeDisabled();

    await user.type(otcInput, '{backspace}');
    expect(verifyBtn).toBeDisabled();

    await user.type(otcInput, '{backspace}');
    expect(otcInput).toHaveValue('123456');
    expect(verifyBtn).not.toBeDisabled();
    await user.click(verifyBtn);

    await waitFor(() => expect(mocks.verifyOTC).toHaveBeenCalledWith(expect.objectContaining({ code: '123456' })));
  });

  it('completes partner signup when the server admits the verified email on an invite-only instance', async () => {
    const user = userEvent.setup();
    const email = 'new@partner.example';
    mocks.verifyOTC
      .mockResolvedValueOnce({
        registrationRequired: true,
        registrationAllowed: true,
        email,
        pendingToken: 'ptok-partner',
      })
      .mockResolvedValueOnce({ user: { id: 'partner-user', email, username: 'partner-user' }, accessToken: 'atk' });

    renderLogin({ enableRegister: false });
    await advanceToUsernameStep(user, email);
    await user.type(textboxIn('login-register-username-input'), 'partner-user');
    await acceptInlinePolicies(user);
    await user.click(screen.getByTestId('login-register-username-btn'));

    await waitFor(() => expect(mocks.setCurrentUser).toHaveBeenCalled());
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(
      expect.objectContaining({
        email,
        username: 'partner-user',
        pendingToken: 'ptok-partner',
        acceptedPolicyVersion: CURRENT_POLICY_VERSION,
        ageAttestation: true,
      })
    );
    expect(mocks.accessTokenState.setVerifiedSession).toHaveBeenCalledWith('atk');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('retries with the rotated token after registration is denied and a partner rule is enabled', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC
      .mockResolvedValueOnce({
        registrationRequired: true,
        registrationAllowed: false,
        email: 'new@partner.example',
        pendingToken: 'ptok-denied',
      })
      .mockResolvedValueOnce({
        registrationRequired: true,
        registrationAllowed: true,
        email: 'new@partner.example',
        pendingToken: 'ptok-admitted',
      });
    renderLogin({ enableRegister: false });

    await user.type(textboxIn('login-email-input'), 'new@partner.example');
    await user.click(screen.getByTestId('login-continue-btn'));
    await user.type(within(await screen.findByTestId('login-otc-input')).getByRole('textbox'), '12345678');
    await user.click(screen.getByTestId('login-verify-btn'));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('auth.registrationClosed', expect.anything()));

    await user.click(screen.getByTestId('login-verify-btn'));

    expect(await screen.findByTestId('login-register-username-input')).toBeInTheDocument();
    expect(mocks.verifyOTC).toHaveBeenLastCalledWith(expect.objectContaining({ pendingToken: 'ptok-denied' }));
  });

  it.each([
    [false, undefined],
    [false, false],
    [true, false],
  ])(
    'refuses username entry with enableRegister=%s and server admission=%s',
    async (enableRegister, registrationAllowed) => {
      const user = userEvent.setup();
      mocks.verifyOTC.mockResolvedValueOnce({
        registrationRequired: true,
        registrationAllowed,
        email: 'new@test.com',
        pendingToken: 'ptok-2',
      });

      renderLogin({ enableRegister });

      await user.type(textboxIn('login-email-input'), 'new@test.com');
      await user.click(screen.getByTestId('login-continue-btn'));

      const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
      await user.type(otcInput, '12345678');
      await user.click(screen.getByTestId('login-verify-btn'));

      await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('auth.registrationClosed', expect.anything()));
      expect(mocks.toast.dismiss).toHaveBeenCalledWith('otc-code-sent');
      // Must NOT strand the user on the username step, and must not create a session.
      expect(screen.queryByTestId('login-register-username-input')).not.toBeInTheDocument();
      expect(mocks.setCurrentUser).not.toHaveBeenCalled();
    }
  );
});

describe('MultiStepLogin - OAuth sign-in start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
    mocks.startOAuthSignIn.mockResolvedValue(undefined);
  });

  it.each([
    ['login-google-btn', '/api/auth/google'],
    ['login-github-btn', '/api/auth/github'],
    ['login-okta-btn', '/api/auth/okta'],
  ])('starts the provider sign-in through the challenge-aware hook from %s', async (testId, startUrl) => {
    const user = userEvent.setup();
    renderLogin();
    await user.click(screen.getByTestId(testId));
    expect(mocks.startOAuthSignIn).toHaveBeenCalledWith(startUrl);
  });

  it('routes an email-strategy redirect through the same hook', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ requiresRedirect: true, redirectUrl: '/api/auth/github' }),
      })
    );
    renderLogin();
    await user.type(textboxIn('login-email-input'), 'dev@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));
    await waitFor(() => expect(mocks.startOAuthSignIn).toHaveBeenCalledWith('/api/auth/github'));
    expect(mocks.sendOTC).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('shows the challenge error and stays on the page when the sign-in cannot start', async () => {
    const user = userEvent.setup();
    mocks.startOAuthSignIn.mockRejectedValue(new Error('Could not complete the verification check.'));
    renderLogin();
    await user.click(screen.getByTestId('login-google-btn'));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Could not complete the verification check.'));
  });

  it('returns to the email step when an email-strategy redirect cannot start', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ requiresRedirect: true, redirectUrl: '/api/auth/github' }),
      })
    );
    mocks.startOAuthSignIn.mockRejectedValue(new Error('Could not complete the verification check.'));
    renderLogin();
    await user.type(textboxIn('login-email-input'), 'dev@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('Could not complete the verification check.'));
    expect(screen.getByTestId('login-continue-btn')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

// The "already logged in" bounce must gate on a LIVE session (currentUser + token), not on a
// stale persisted currentUser alone - otherwise a broken session is trapped in a /login <->
// /accept-policies loop (issue #386). See the isLoggedIn guard in MultiStepLogin.
describe('MultiStepLogin — already-logged-in redirect guard', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
  });

  it('renders the login form and does NOT redirect when currentUser is a stale stub with no access token', () => {
    // The deadlock case: a persisted currentUser survives with no live token. The form must show
    // so the broken session can re-authenticate, and it must not be bounced back into the app shell.
    mocks.userState.currentUser = { id: 'stale-user' };
    mocks.accessTokenState.accessToken = null;

    renderLogin();

    expect(screen.getByTestId('login-email-input')).toBeInTheDocument();
    expect(mocks.applyRedirect).not.toHaveBeenCalled();
  });

  it('redirects away from /login when there is a live session (currentUser + access token)', () => {
    mocks.userState.currentUser = { id: 'real-user' };
    mocks.accessTokenState.accessToken = 'live-token';

    renderLogin();

    // isLoggedIn short-circuits the render to null and the effect bounces to the app shell.
    expect(screen.queryByTestId('login-email-input')).not.toBeInTheDocument();
    expect(mocks.applyRedirect).toHaveBeenCalledWith(expect.anything(), null, '/new', true);
  });
});

// The login screen is where a signed-out visitor meets the banner, so it is the only place
// they can change a decision before an account exists.
describe('MultiStepLogin - Cookie settings link', () => {
  const TRACKER_ENV = ['NEXT_PUBLIC_GA_MEASUREMENT_ID', 'NEXT_PUBLIC_REDDIT_PIXEL_ID', 'NEXT_PUBLIC_META_PIXEL_ID'];

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
    for (const name of TRACKER_ENV) vi.stubEnv(name, '');
    useCookieSettings.setState({ isOpen: false });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.websiteUrl = '';
  });

  it('reopens the consent banner from a keyboard-reachable button', () => {
    vi.stubEnv('NEXT_PUBLIC_GA_MEASUREMENT_ID', 'test-id');
    renderLogin();

    const link = screen.getByTestId('login-cookie-settings-link');
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link);

    expect(useCookieSettings.getState().isOpen).toBe(true);
  });

  it('opens settings for attribution consent when no tracker is configured', () => {
    renderLogin();

    expect(screen.getByTestId('login-email-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('login-cookie-settings-link'));
    expect(useCookieSettings.getState().isOpen).toBe(true);
  });

  it('follows the legal sentence even without a tracker', () => {
    mocks.websiteUrl = 'https://marketing.test';
    renderLogin();

    expect(screen.getByText(/By continuing, you agree to our/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('login-cookie-settings-link'));
    expect(useCookieSettings.getState().isOpen).toBe(true);
  });

  it('follows the legal sentence when both are configured', () => {
    mocks.websiteUrl = 'https://marketing.test';
    vi.stubEnv('NEXT_PUBLIC_REDDIT_PIXEL_ID', 'test-id');
    renderLogin();

    expect(screen.getByText(/By continuing, you agree to our/)).toBeInTheDocument();
    expect(screen.getByTestId('login-cookie-settings-link')).toBeInTheDocument();
  });
});

// The email step must tell a returning user that a one-time code is emailed, so they do not go
// looking for a password field or a forgot-password link that this flow does not have.
describe('MultiStepLogin - passwordless email step copy', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
  });

  it('tells the user a one-time code is emailed and offers no password or forgot-password affordance', () => {
    renderLogin();

    // The i18n mock echoes the key, so the subtitle's rendered text is its translation key. Pinning
    // the key proves the email step still renders auth.signInOrCreate; the value is checked below.
    expect(screen.getByText('auth.signInOrCreate')).toBeInTheDocument();

    // The copy behind that key names the emailed code and says no password is needed.
    expect(en.auth.signInOrCreate).toMatch(/one-time code/i);
    expect(en.auth.signInOrCreate).toMatch(/no password required/i);
    expect(en.auth.signInOrCreate).not.toMatch(/forgot/i);

    // The email step exposes no password field and no forgot-password link.
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByText(/forgot/i)).toBeNull();
    // Accessible-name queries also catch an icon-only control labelled through aria-label.
    expect(screen.queryByRole('link', { name: /forgot/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /forgot/i })).toBeNull();
  });
});

describe('MultiStepLogin - email step guidance and code-request errors', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requiresRedirect: false }),
    }) as unknown as typeof fetch;
  });

  it('ties an invalid-email error to the input and announces it', async () => {
    const user = userEvent.setup();
    renderLogin();

    const input = textboxIn('login-email-input');
    await user.type(input, 'not-an-email');
    fireEvent.submit(input.closest('form')!);

    const alert = await screen.findByTestId('login-email-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('auth.fieldErrors.invalidEmail');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
  });

  it('clears the email error once the user types again', async () => {
    const user = userEvent.setup();
    renderLogin();

    const input = textboxIn('login-email-input');
    await user.type(input, 'not-an-email');
    fireEvent.submit(input.closest('form')!);
    await screen.findByTestId('login-email-error');

    await user.type(input, 'x');
    expect(screen.queryByTestId('login-email-error')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows an alert and a Continue countdown when the code request is rate limited', async () => {
    const user = userEvent.setup();
    mocks.sendOTC.mockRejectedValueOnce({
      message: 'Rate limit exceeded. Try again in 529 seconds',
      code: 'CLIENT_ERROR_429',
      retryAfterSeconds: 529,
    });
    renderLogin();

    await user.type(textboxIn('login-email-input'), 'someone@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));

    const alert = await screen.findByTestId('login-rate-limit-alert');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('auth.rateLimitedMinutes');
    expect(screen.getByTestId('login-continue-btn')).toBeDisabled();
    expect(screen.getByTestId('login-continue-btn')).toHaveTextContent('auth.retryIn');
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('shows the same notice, not a toast, when resending a code is rate limited', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.sendOTC.mockResolvedValueOnce({ pendingToken: 'ptok-1' }).mockRejectedValueOnce({
        message: 'Rate limit exceeded',
        code: 'CLIENT_ERROR_429',
        retryAfterSeconds: 120,
      });
      renderLogin();

      await user.type(textboxIn('login-email-input'), 'someone@test.com');
      await user.click(screen.getByTestId('login-continue-btn'));
      await screen.findByTestId('login-resend-btn');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31000);
      });
      await user.click(screen.getByTestId('login-resend-btn'));

      const alert = await screen.findByTestId('login-otc-rate-limit-alert');
      expect(alert).toHaveAttribute('role', 'alert');
      expect(screen.getByTestId('login-resend-btn')).toHaveTextContent('2:00');
      expect(mocks.toast.error).not.toHaveBeenCalled();

      await user.click(screen.getByTestId('login-resend-btn'));
      expect(mocks.sendOTC).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second Resend click while a resend is still in flight', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let finishResend: (value: { pendingToken: string }) => void = () => {};
      mocks.sendOTC
        .mockResolvedValueOnce({ pendingToken: 'ptok-1' })
        .mockReturnValueOnce(new Promise(resolve => (finishResend = resolve)));
      renderLogin();

      await user.type(textboxIn('login-email-input'), 'someone@test.com');
      await user.click(screen.getByTestId('login-continue-btn'));
      await screen.findByTestId('login-resend-btn');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31000);
      });
      await user.dblClick(screen.getByTestId('login-resend-btn'));
      expect(mocks.sendOTC).toHaveBeenCalledTimes(2);

      await act(async () => finishResend({ pendingToken: 'ptok-2' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31000);
      });
      await user.click(screen.getByTestId('login-resend-btn'));
      expect(mocks.sendOTC).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MultiStepLogin - second-factor handoff', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
    mocks.mfa.options = null;
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requiresRedirect: false }),
    }) as unknown as typeof fetch;
  });

  const submitCode = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(textboxIn('login-email-input'), 'a@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));
    const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
    await user.type(otcInput, '12345678');
    await user.click(screen.getByTestId('login-verify-btn'));
  };

  it('begins a verify challenge when the code step answers mfaRequired', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({
      mfaRequired: true,
      userId: 'u1',
      accessToken: 'pending-tok',
      passkeyAvailable: true,
    });
    renderLogin();

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

  it('begins a setup challenge when the code step answers mfaSetupRequired', async () => {
    mocks.verifyOTC.mockResolvedValueOnce({ mfaSetupRequired: true, userId: 'u1', accessToken: 'pending-tok' });
    renderLogin();

    await submitCode(userEvent.setup());

    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalledTimes(1));
    expect(mocks.mfa.begin).toHaveBeenCalledWith({ userId: 'u1', mfaToken: 'pending-tok', mode: 'setup' });
  });

  it('begins the challenge when the inline registration answers with an MFA login shape', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC
      .mockResolvedValueOnce({ registrationRequired: true, email: 'new@test.com', pendingToken: 'ptok-2' })
      .mockResolvedValueOnce({ mfaRequired: true, userId: 'u2', accessToken: 'pending-2' });
    renderLogin();

    await advanceToUsernameStep(user);
    await user.type(textboxIn('login-register-username-input'), 'newbie');
    await acceptInlinePolicies(user);
    await user.click(screen.getByTestId('login-register-username-btn'));

    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalledTimes(1));
    expect(mocks.mfa.begin).toHaveBeenCalledWith({
      userId: 'u2',
      mfaToken: 'pending-2',
      mode: 'verify',
      passkeyAvailable: false,
    });
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();
  });

  it('sets the current user from the completed challenge', () => {
    renderLogin();

    mocks.mfa.options!.onComplete({ accessToken: 'full', user: { id: 'u1' } });

    expect(mocks.setCurrentUser).toHaveBeenCalledWith({ id: 'u1' });
  });

  it.each([
    ['verify', 'error'],
    ['setup', 'info'],
  ] as const)(
    'restarts from the email step with a %s notice when the challenge is cancelled',
    async (mode, toastKind) => {
      mocks.verifyOTC.mockResolvedValueOnce({ mfaRequired: true, userId: 'u1', accessToken: 'pending-tok' });
      renderLogin();
      await submitCode(userEvent.setup());
      await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalled());
      expect(screen.queryByTestId('login-email-input')).not.toBeInTheDocument();

      act(() => mocks.mfa.options!.onCancel!(mode));

      expect(await screen.findByTestId('login-email-input')).toBeInTheDocument();
      expect(mocks.toast[toastKind as 'error' | 'info']).toHaveBeenCalledTimes(1);
    }
  );
});

describe('MultiStepLogin - OAuth registration_closed redirect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userState.currentUser = null;
    mocks.accessTokenState.accessToken = null;
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('explains the invite gate and offers the waitlist, then strips the code from the URL', async () => {
    window.history.replaceState({}, '', '/login?error=registration_closed');
    renderLogin({ enableRegister: false });

    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringMatching(/invite-only/), expect.anything())
    );
    const [, options] = mocks.toast.error.mock.calls[0];
    options.action.onClick();
    expectWaitlistNavigation('oauth_signup_closed', undefined);
    expect(window.location.search).toBe('');
  });

  it('adds no waitlist action to other sign-in errors', async () => {
    window.history.replaceState({}, '', '/login?error=callback_error');
    renderLogin({ enableRegister: false });

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    const [, options] = mocks.toast.error.mock.calls[0];
    expect(options.action).toBeUndefined();
  });
});

describe('MultiStepLogin - signup bot checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.formToken.data = 'form-tok-1';
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requiresRedirect: false }),
    }) as unknown as typeof fetch;
  });

  const submitEmail = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(textboxIn('login-email-input'), 'new@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));
    await screen.findByTestId('login-otc-input');
  };

  it('sends the form token and an empty honeypot value with the initial code request', async () => {
    renderLogin();
    await submitEmail(userEvent.setup());
    expect(mocks.sendOTC).toHaveBeenCalledWith({ email: 'new@test.com', formToken: 'form-tok-1', formExtra: '' });
  });

  it('sends the honeypot value when it was filled', async () => {
    const user = userEvent.setup();
    renderLogin();
    await user.type(screen.getByTestId('signup-honeypot-input'), 'spam');
    await submitEmail(user);
    expect(mocks.sendOTC).toHaveBeenCalledWith(expect.objectContaining({ formExtra: 'spam' }));
  });

  it('submits immediately without a token when none is loaded', async () => {
    mocks.formToken.data = undefined;
    renderLogin();
    await submitEmail(userEvent.setup());
    expect(mocks.formToken.refetch).not.toHaveBeenCalled();
    expect(mocks.sendOTC).toHaveBeenCalledWith({ email: 'new@test.com', formToken: undefined, formExtra: '' });
  });
});

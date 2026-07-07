import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import MultiStepLogin from './MultiStepLogin';

// Factory-safe mock handles (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  sendOTC: vi.fn(),
  verifyOTC: vi.fn(),
  setCurrentUser: vi.fn(),
  trackSignupConversion: vi.fn(),
  accessTokenState: {
    setVerifiedTokens: vi.fn(),
    resetTokens: vi.fn(),
    setMfaPendingTokens: vi.fn(),
    forceLogoutTokens: vi.fn(),
  },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/hooks/data/auth', () => ({
  useSendOTC: () => ({ mutateAsync: mocks.sendOTC, isPending: false }),
  useVerifyOTC: () => ({ mutateAsync: mocks.verifyOTC, isPending: false }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ setCurrentUser: mocks.setCurrentUser, currentUser: null }),
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: Object.assign(() => mocks.accessTokenState, { getState: () => mocks.accessTokenState }),
}));
vi.mock('@client/app/hooks/data/mfa', () => ({
  useVerifyMFA: () => ({ mutateAsync: vi.fn() }),
  useSetupMFA: () => ({ mutateAsync: vi.fn() }),
  useVerifyMFASetup: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: {} }),
}));
// finishLogin calls applyRedirect(router.history, ...); stub it so the empty history is inert.
vi.mock('@client/app/utils/authRedirect', () => ({
  applyRedirect: vi.fn(),
  appendRedirectTo: (url: string) => url,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ resetRefreshPromise: vi.fn() }));
vi.mock('@client/app/utils/signupConversion', () => ({ trackSignupConversion: mocks.trackSignupConversion }));
vi.mock('@client/app/hooks/useCommonStyles', () => ({
  useCommonStyles: () => ({ inputStyles: {}, dividerStyles: {} }),
}));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@client/app/hooks/data/settings', () => ({ useBrandingSettings: () => ({}) }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderLogin = (props: React.ComponentProps<typeof MultiStepLogin> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <MultiStepLogin {...props} />
    </CssVarsProvider>
  );

const textboxIn = (testId: string) => within(screen.getByTestId(testId)).getByRole('textbox');
const checkboxIn = (testId: string) => within(screen.getByTestId(testId)).getByRole('checkbox');

// Drives the flow from the email step to the register-username step (email -> code ->
// registrationRequired). Assumes mocks.verifyOTC's FIRST call resolves registrationRequired.
const advanceToUsernameStep = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(textboxIn('login-email-input'), 'new@test.com');
  await user.click(screen.getByTestId('login-continue-btn'));
  const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
  await user.type(otcInput, '123456');
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
    vi.clearAllMocks();
    mocks.sendOTC.mockResolvedValue({ pendingToken: 'ptok-1' });
    // Strategy check for a passwordless email - no SSO redirect.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requiresRedirect: false }),
    }) as unknown as typeof fetch;
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
    // Regression guard: the user must be flattened, NOT the { user, accessToken, refreshToken } wrapper.
    expect(arg).toMatchObject({
      id: 'new-1',
      email: 'new@test.com',
      username: 'newbie',
      accessToken: 'atk',
      refreshToken: 'rtk',
    });
    expect(arg).not.toHaveProperty('user');
    expect(mocks.accessTokenState.setVerifiedTokens).toHaveBeenCalledWith('atk', 'rtk');
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

  it('does not advance to the username step when open registration is disabled', async () => {
    const user = userEvent.setup();
    mocks.verifyOTC.mockResolvedValueOnce({
      registrationRequired: true,
      email: 'new@test.com',
      pendingToken: 'ptok-2',
    });

    renderLogin({ enableRegister: false });

    await user.type(textboxIn('login-email-input'), 'new@test.com');
    await user.click(screen.getByTestId('login-continue-btn'));

    const otcInput = within(await screen.findByTestId('login-otc-input')).getByRole('textbox');
    await user.type(otcInput, '123456');
    await user.click(screen.getByTestId('login-verify-btn'));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('auth.registrationClosed'));
    // Must NOT strand the user on the username step, and must not create a session.
    expect(screen.queryByTestId('login-register-username-input')).not.toBeInTheDocument();
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();
  });
});

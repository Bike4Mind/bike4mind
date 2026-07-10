import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ExternalLinks } from '@client/app/utils/externalLinks';

// Route/context deps are stubbed; the real @mui/joy Checkbox + Link render so we can
// assert the anchors the acceptance gate exposes. An authenticated user without a recorded
// acceptance keeps the page from redirecting away, so the form (and its links) renders.
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ history: {} }),
  useSearch: () => ({}),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1' }, setCurrentUser: vi.fn() }),
}));
const mockUseAccessToken = vi.fn();
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: () => mockUseAccessToken(),
}));
const mockApiPost = vi.fn();
const mockForceSessionExpiredRedirect = vi.fn().mockResolvedValue(undefined);
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => mockApiPost(...args) },
  forceSessionExpiredRedirect: (...args: unknown[]) => mockForceSessionExpiredRedirect(...args),
  // Mirrors the real helpers' observable behavior (pull fields off an axios-shaped error)
  // without depending on axios's actual isAxiosError marker in test fixtures.
  getAxiosErrorStatus: (error: unknown) => (error as { response?: { status?: number } } | undefined)?.response?.status,
  getAxiosRetryCount: (error: unknown) =>
    (error as { config?: { _retryCount?: number } } | undefined)?.config?._retryCount ?? 0,
}));
const mockUseGetIdentify = vi.fn();
vi.mock('@client/app/hooks/data/user', () => ({
  useGetIdentify: () => mockUseGetIdentify(),
}));
vi.mock('@client/app/hooks/useGetLogo', () => ({ default: () => '/logo.png' }));
vi.mock('@client/app/utils/authRedirect', () => ({ applyRedirect: vi.fn() }));
vi.mock('next/image', () => ({ default: () => null }));

import AcceptPoliciesPage from './accept-policies';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPage = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AcceptPoliciesPage />
    </CssVarsProvider>
  );

// MUI Joy's Checkbox puts the actual <input> (and its onChange, and its disabled state)
// inside the data-testid'd root span - interact with the input directly, not the wrapper.
const checkboxInput = (testId: string) => {
  const input = screen.getByTestId(testId).querySelector('input');
  if (!input) throw new Error(`No <input> found inside checkbox "${testId}"`);
  return input;
};

const acceptForm = () => {
  fireEvent.click(checkboxInput('accept-policies-checkbox'));
  fireEvent.click(checkboxInput('accept-age-checkbox'));
  fireEvent.click(screen.getByTestId('accept-policies-submit-btn'));
};

const confirmed401 = { response: { status: 401, data: { error: 'Unauthorized' } } };
const serverError = { response: { status: 500, data: { error: 'Server error' } } };
// A first-attempt 401 (the interceptor's refresh attempt itself failed, not yet retried).
const transient401 = { response: { status: 401, data: { error: 'Unauthorized' } }, config: { _retryCount: 0 } };
// The interceptor already completed its own refresh-succeeded-then-retried cycle and still
// got 401 - config._retryCount reflects that.
const alreadyRetried401 = { response: { status: 401, data: { error: 'Unauthorized' } }, config: { _retryCount: 1 } };
// Real timeout comfortably past SUBMIT_RETRY_DELAY_MS (1000ms in the component).
const RETRY_WAIT_OPTS = { timeout: 2000 };

describe('AcceptPoliciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForceSessionExpiredRedirect.mockResolvedValue(undefined);
    mockUseAccessToken.mockReturnValue({ accessToken: 'atk', mfaPending: false });
    mockUseGetIdentify.mockReturnValue({ isError: false, error: null });
  });

  // Regression guard for #59: the ToS/AUP/Privacy links in the acceptance-checkbox label must
  // point at the right policy pages and open in a new tab. (The underlying bug - clicks landing
  // on the checkbox's transparent input overlay instead of the anchor - is a visual stacking-order
  // issue jsdom cannot reproduce, so it is verified in a browser, not here. See the fix: each Link
  // is raised above the overlay (which is zIndex: 1) with sx={{ position: 'relative', zIndex: 2 }}.)
  it('renders the policy links with the correct href, new-tab target, and rel', () => {
    renderPage();

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

  it('does not tear down while identify has not (yet) failed', () => {
    renderPage();

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });

  // A bootstrap /api/identify that comes back with a confirmed 401 (a stale token whose refresh
  // attempt itself failed) must not strand the user on this interstitial forever - it should fall
  // back to the same clean-sign-out teardown used for any other unrecoverable 401, instead of
  // silently sitting on a form the session can't actually submit.
  it('tears down when identify fails with a confirmed 401', async () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: confirmed401 });

    renderPage();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1));
  });

  // A background-refetch blip unrelated to auth (network drop, 5xx) says nothing about whether
  // this session is actually dead - tearing down on any identify error would log out users with
  // perfectly valid sessions on a transient hiccup.
  it('does not tear down when identify fails with a non-401 error', () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: serverError });

    renderPage();

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
    expect(checkboxInput('accept-policies-checkbox')).not.toBeDisabled();
  });

  // During mfaPending no refresh token is issued by design, so a 401 on identify is expected,
  // not a sign of a dead session - tearing down here would destroy an in-progress MFA setup.
  it('does not tear down on a confirmed 401 while mfaPending', () => {
    mockUseAccessToken.mockReturnValue({ accessToken: 'atk', mfaPending: true });
    mockUseGetIdentify.mockReturnValue({ isError: true, error: confirmed401 });

    renderPage();

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });

  it('disables the form while the session is unverified', () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: confirmed401 });

    renderPage();

    expect(checkboxInput('accept-policies-checkbox')).toBeDisabled();
    expect(checkboxInput('accept-age-checkbox')).toBeDisabled();
    expect(screen.getByTestId('accept-policies-submit-btn')).toBeDisabled();
  });

  // A first-attempt 401 (the interceptor's own refresh attempt itself failed, not yet retried)
  // gets one automatic backoff retry before anything is shown to the user - a confirmed
  // unrecoverable 401 already redirects via ApiContext's own interceptor before this catch ever
  // runs, so this is specifically the "maybe it's already cleared up" case. If the retry
  // recovers, the user never even sees an error.
  it('auto-retries a first-attempt 401 once and succeeds silently if the retry recovers', async () => {
    mockApiPost
      .mockRejectedValueOnce(transient401)
      .mockResolvedValueOnce({ data: { user: { id: 'u1', aupAcceptedVersion: 'v1' } } });

    renderPage();
    acceptForm();

    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(2), RETRY_WAIT_OPTS);
    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
    expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument();
  });

  // If the backoff retry also 401s, that's as far as this page can recover on its own - fall
  // back to the same clean sign-out used for any other unrecoverable session, rather than
  // resubmitting forever or dead-ending on a raw error.
  it('tears down if the backoff retry also 401s', async () => {
    mockApiPost.mockRejectedValue(transient401);

    renderPage();
    acceptForm();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1), RETRY_WAIT_OPTS);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
    // isSubmitting must be reset even on the teardown path, so a no-op redirect (e.g. a
    // concurrent teardown already in flight) never leaves the button stuck loading.
    expect(screen.getByTestId('accept-policies-submit-btn')).not.toBeDisabled();
  });

  // If the interceptor already completed its own refresh-succeeded-then-retried cycle for this
  // error (config._retryCount already >= 1), a further client-side retry can't help - skip the
  // backoff delay entirely and tear down immediately.
  it('tears down immediately with no backoff retry when the interceptor already retried once', async () => {
    mockApiPost.mockRejectedValue(alreadyRetried401);

    renderPage();
    acceptForm();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1));
    expect(mockApiPost).toHaveBeenCalledTimes(1);
  });

  // A failure unrelated to auth (an unrelated backend bug, a validation error) says nothing about
  // the session - it must stay retryable indefinitely rather than eventually forcing a sign-out.
  it('never tears down on repeated non-401 submit failures', async () => {
    mockApiPost.mockRejectedValue(serverError);

    renderPage();

    acceptForm();
    await waitFor(() => expect(screen.getByText('Server error')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('accept-policies-submit-btn'));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(2));

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });

  it('does not tear down on repeated 401 submit failures while mfaPending', async () => {
    mockUseAccessToken.mockReturnValue({ accessToken: 'atk', mfaPending: true });
    mockApiPost.mockRejectedValue(confirmed401);

    renderPage();

    acceptForm();
    await waitFor(() => expect(screen.getByText('Unauthorized')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('accept-policies-submit-btn'));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(2));

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });
});

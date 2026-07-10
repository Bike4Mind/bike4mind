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
  // Mirrors the real helper's observable behavior (pull the status off an axios-shaped
  // error) without depending on axios's actual isAxiosError marker in test fixtures.
  getAxiosErrorStatus: (error: unknown) => (error as { response?: { status?: number } } | undefined)?.response?.status,
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

  // The first submit failure should look recoverable (show the error, let the user retry) since
  // a confirmed unrecoverable 401 already redirects via ApiContext's own interceptor before this
  // catch ever runs. Only a second consecutive 401 - most likely a sustained transient refresh
  // outage the interceptor deliberately didn't log out for - falls back to a clean sign-out
  // instead of resubmitting forever, and the real error text stays visible right up to that point.
  it('shows a retryable error on the first 401 submit failure, then tears down on the second', async () => {
    mockApiPost.mockRejectedValue(confirmed401);

    renderPage();

    acceptForm();
    await waitFor(() => expect(screen.getByText('Unauthorized')).toBeInTheDocument());
    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('accept-policies-submit-btn')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('accept-policies-submit-btn'));
    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1));
    // isSubmitting must be reset even on the teardown path, so a no-op redirect (e.g. a
    // concurrent teardown already in flight) never leaves the button stuck loading.
    expect(screen.getByTestId('accept-policies-submit-btn')).not.toBeDisabled();
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

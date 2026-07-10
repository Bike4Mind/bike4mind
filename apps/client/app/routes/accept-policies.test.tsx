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
// A plain mutable object (not a vi.fn() return-value mock) so both the hook call and the
// imperative getState() call - which the component uses to re-read mfaPending live, not from
// a stale closure - read the same live values, matching real zustand's single-store semantics.
const mockAccessTokenState = { accessToken: 'atk' as string | null, mfaPending: false };
vi.mock('@client/app/hooks/useAccessToken', () => {
  const useAccessToken = () => mockAccessTokenState;
  useAccessToken.getState = () => mockAccessTokenState;
  return { useAccessToken };
});
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

// withRetry (the real, unmocked implementation) coerces a thrown non-Error into a generic
// Error before passing it to isRetryable, which would strip a plain-object fixture's
// response/config - so fixtures must be real Error instances to survive that coercion intact.
const makeAxiosError = (status: number, message: string, retryCount?: number) => {
  const err = new Error(message) as Error & { response: unknown; config?: unknown };
  err.response = { status, data: { error: message } };
  if (retryCount !== undefined) {
    err.config = { _retryCount: retryCount };
  }
  return err;
};

const serverError = makeAxiosError(500, 'Server error');
// A first-attempt 401 (the interceptor's refresh attempt itself failed, not yet retried).
const transient401 = makeAxiosError(401, 'Unauthorized', 0);
// The interceptor already completed its own refresh-succeeded-then-retried cycle and still
// got 401 - config._retryCount reflects that.
const alreadyRetried401 = makeAxiosError(401, 'Unauthorized', 1);
// Real timeout comfortably past SUBMIT_RETRY_DELAY_MS (1000ms in the component, plus jitter).
const RETRY_WAIT_OPTS = { timeout: 2000 };

describe('AcceptPoliciesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForceSessionExpiredRedirect.mockResolvedValue(undefined);
    mockAccessTokenState.accessToken = 'atk';
    mockAccessTokenState.mfaPending = false;
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

  // Only once ApiContext's interceptor has completed its own refresh-succeeded-then-retried
  // cycle and still gotten 401 (config._retryCount >= 1) is this genuinely unrecoverable - a
  // first-attempt 401 (retryCount 0) can equally mean the refresh endpoint itself failed
  // transiently, which the interceptor deliberately does NOT treat as unrecoverable.
  it('tears down when identify fails with a confirmed, already-retried 401', async () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: alreadyRetried401 });

    renderPage();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1));
  });

  // A first-attempt 401 on identify (retryCount 0) can be a transient refresh-endpoint outage
  // (e.g. a cold Lambda right after a deploy) - exactly the case ApiContext's own interceptor
  // deliberately does not tear down for, to avoid a spurious logout storm. This page must not
  // force a teardown on that signal alone either.
  it('does not tear down when identify fails with a first-attempt (not-yet-retried) 401', () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: transient401 });

    renderPage();

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
    expect(checkboxInput('accept-policies-checkbox')).not.toBeDisabled();
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
    mockAccessTokenState.mfaPending = true;
    mockUseGetIdentify.mockReturnValue({ isError: true, error: alreadyRetried401 });

    renderPage();

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });

  it('disables the form while the session is unverified', () => {
    mockUseGetIdentify.mockReturnValue({ isError: true, error: alreadyRetried401 });

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
  // resubmitting forever or dead-ending on a raw error. The real error text stays visible right
  // up to that point rather than being silently dropped.
  it('tears down if the backoff retry also 401s, showing the error first', async () => {
    mockApiPost.mockRejectedValue(transient401);

    renderPage();
    acceptForm();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1), RETRY_WAIT_OPTS);
    expect(mockApiPost).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
    // isSubmitting must be reset even on the teardown path, so a no-op redirect (e.g. a
    // concurrent teardown already in flight) never leaves the button stuck loading.
    expect(screen.getByTestId('accept-policies-submit-btn')).not.toBeDisabled();
  });

  // If the interceptor already completed its own refresh-succeeded-then-retried cycle for this
  // error (config._retryCount already >= 1), a further client-side retry can't help - skip the
  // backoff delay entirely and tear down immediately, still showing the error first.
  it('tears down immediately with no backoff retry when the interceptor already retried once', async () => {
    mockApiPost.mockRejectedValue(alreadyRetried401);

    renderPage();
    acceptForm();

    await waitFor(() => expect(mockForceSessionExpiredRedirect).toHaveBeenCalledTimes(1));
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Unauthorized')).toBeInTheDocument();
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
    mockAccessTokenState.mfaPending = true;
    mockApiPost.mockRejectedValue(alreadyRetried401);

    renderPage();

    acceptForm();
    await waitFor(() => expect(screen.getByText('Unauthorized')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('accept-policies-submit-btn'));
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledTimes(2));

    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });

  // mfaPending is re-read live (useAccessToken.getState()) rather than closed over at the start
  // of the submit, since the retry chain can run up to a second later - a cross-tab mfaPending
  // rehydrate mid-wait must not be missed by a stale closure.
  it('re-reads mfaPending fresh rather than using a stale value from when the submit started', async () => {
    let callCount = 0;
    mockApiPost.mockImplementation(() => {
      callCount += 1;
      if (callCount === 2) {
        mockAccessTokenState.mfaPending = true;
      }
      return Promise.reject(transient401);
    });

    renderPage();
    acceptForm();

    await waitFor(() => expect(callCount).toBe(2), RETRY_WAIT_OPTS);
    expect(mockForceSessionExpiredRedirect).not.toHaveBeenCalled();
  });
});

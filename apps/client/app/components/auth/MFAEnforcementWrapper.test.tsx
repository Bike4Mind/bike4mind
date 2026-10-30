import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ADMIN_SETTINGS_QUERY_KEY } from '@client/app/hooks/data/queryKeys';

// The api layer: MFA status resolves (so enforcement logic runs), but /api/auth/mfa/setup
// PERSISTENTLY fails - the exact condition that used to spin the auto-setup effect forever.
const post = vi.fn();
const get = vi.fn();
const { interceptorUse, interceptorEject } = vi.hoisted(() => ({
  interceptorUse: vi.fn((..._args: unknown[]): number => 0),
  interceptorEject: vi.fn(),
}));
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
    get: (...args: unknown[]) => get(...args),
    interceptors: { response: { use: interceptorUse, eject: interceptorEject } },
  },
  isPublicPath: () => false,
}));

// enforceMFA on, admin settings loaded.
const { adminSettings } = vi.hoisted(() => ({ adminSettings: { enforceMFA: 'true' } }));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ settings: { ...adminSettings }, isLoading: false }),
}));

// A signed-in user with no MFA configured (so enforcement wants to auto-start setup).
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (s: unknown) => unknown) => selector({ currentUser: { id: 'u1', mfa: null } }),
}));

// Not impersonating; getState is only touched on the verify path (not exercised here).
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: Object.assign((selector: (s: unknown) => unknown) => selector({ impersonating: false }), {
    getState: () => ({ forceLogoutTokens: vi.fn() }),
  }),
}));

const { logoutMutate } = vi.hoisted(() => ({ logoutMutate: vi.fn() }));
vi.mock('@client/app/hooks/data/user', () => ({
  useUserLogout: () => ({ mutate: logoutMutate, isPending: false }),
}));

// A stub modal: surfaces the inline error and lets a test submit a code.
vi.mock('@client/app/components/common/MFAModal', () => ({
  default: ({
    error,
    mode,
    onVerify,
  }: {
    error?: string | null;
    mode?: string;
    onVerify: (code: string, remember: boolean) => void;
  }) => (
    <div data-testid="mfa-modal-stub" data-mode={mode}>
      <span data-testid="mfa-modal-stub-error">{error}</span>
      <button data-testid="mfa-modal-stub-verify" onClick={() => onVerify('000000', false)} />
    </div>
  ),
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: toastError, success: vi.fn() } }));

// The interceptor tags a dismissed verification prompt with a private symbol; stand in a marker.
const CANCELLED = 'verification-dismissed';
vi.mock('@client/app/utils/stepUpInterceptor', () => ({
  isStepUpCancelled: (error: unknown) => error instanceof Error && error.message === CANCELLED,
}));

import MFAEnforcementWrapper from './MFAEnforcementWrapper';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <MFAEnforcementWrapper>
          <div data-testid="app-content" />
        </MFAEnforcementWrapper>
      </QueryClientProvider>
    </CssVarsProvider>
  );
  return { ...view, queryClient };
};

const mfaSetupCalls = () => post.mock.calls.filter(([url]) => url === '/api/auth/mfa/setup').length;

describe('MFAEnforcementWrapper - auto-setup does not loop on persistent failure', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockResolvedValue({ data: { enabled: false } }); // MFA status: not yet enabled
    post.mockRejectedValue(new Error('setup failed')); // /api/auth/mfa/setup always errors
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('fires POST /api/auth/mfa/setup exactly once even though it keeps failing', async () => {
    renderWrapper();

    // Wait until the failing setup has been attempted at least once.
    await waitFor(() => expect(mfaSetupCalls()).toBeGreaterThanOrEqual(1));

    // Give the mutation's error settle several ticks to (previously) re-trigger the effect.
    await new Promise(resolve => setTimeout(resolve, 100));

    // The isError guard stops the re-fire: exactly one attempt, not an unbounded storm.
    expect(mfaSetupCalls()).toBe(1);

    // A real (non-cancelled) failure must still surface; only a dismissed prompt stays silent.
    expect(toastError).toHaveBeenCalledWith('setup failed');
  });

  it('renders a retry button on failure, and clicking it fires a new setup attempt', async () => {
    renderWrapper();

    // The auto-attempt fails, so the dead-end "please wait" is replaced by a retry affordance.
    const retry = await screen.findByTestId('mfa-enforcement-retry-btn');
    await waitFor(() => expect(mfaSetupCalls()).toBe(1));

    fireEvent.click(retry);

    // The manual retry re-fires setup (calling mutate clears isError), so the user is not
    // dead-ended - exactly what the auto-guard deliberately won't do on its own.
    await waitFor(() => expect(mfaSetupCalls()).toBe(2));
  });
});

describe('MFAEnforcementWrapper - dismissed verification prompt', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockResolvedValue({ data: { enabled: false } });
    post.mockRejectedValue(new Error(CANCELLED));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers to continue instead of reporting a failure, and continuing retries setup', async () => {
    renderWrapper();

    const continueButton = await screen.findByTestId('mfa-enforcement-continue-btn');
    expect(screen.queryByTestId('mfa-enforcement-retry-btn')).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(mfaSetupCalls()).toBe(1);

    fireEvent.click(continueButton);
    await waitFor(() => expect(mfaSetupCalls()).toBe(2));
  });
});

describe('MFAEnforcementWrapper - a session stuck at the verification prompt', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockResolvedValue({ data: { enabled: false } });
    // Setup waits on the "Confirm it's you" prompt the user never completes.
    post.mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers a sign-out, so the user can sign in fresh and skip the prompt', async () => {
    renderWrapper();

    const signOut = await screen.findByTestId('mfa-enforcement-sign-out-btn');
    await waitFor(() => expect(mfaSetupCalls()).toBe(1));

    fireEvent.click(signOut);
    expect(logoutMutate).toHaveBeenCalledTimes(1);
  });

  it('tells the user when the sign-out fails, instead of leaving them on the screen silently', async () => {
    logoutMutate.mockImplementation((_vars: unknown, options?: { onError?: (e: unknown) => void }) =>
      options?.onError?.(new Error('Network Error'))
    );
    renderWrapper();

    fireEvent.click(await screen.findByTestId('mfa-enforcement-sign-out-btn'));

    expect(toastError).toHaveBeenCalledWith("Couldn't sign out. Please try again.");
  });
});

// Stand-in for the server's enrollment refusal: axios shapes the error, and the client helper
// (mfaEnrollmentInterceptor) keys off `isAxiosError` + the 403 body flag.
const enrollmentRefusal = () => ({
  isAxiosError: true,
  response: { status: 403, data: { mfaEnrollmentRequired: true } },
});

const registeredRefusalHandler = async () => {
  await waitFor(() => expect(interceptorUse).toHaveBeenCalled());
  return interceptorUse.mock.calls[0][1] as (error: unknown) => Promise<unknown>;
};

describe('MFAEnforcementWrapper - the server refuses an enrollment-owing session', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    interceptorUse.mockClear();
    interceptorEject.mockClear();
    get.mockResolvedValue({ data: { enabled: false } });
    post.mockRejectedValue(new Error('setup failed'));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refetches admin settings and MFA status on the first refusal, and ejects on unmount', async () => {
    const { queryClient, unmount } = renderWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const onRejected = await registeredRefusalHandler();
    const refusal = enrollmentRefusal();
    await expect(onRejected(refusal)).rejects.toBe(refusal);

    // Both queries feed the enrollment decision; a stale one renders a broken app.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ADMIN_SETTINGS_QUERY_KEY });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['mfa', 'status'] });

    unmount();
    expect(interceptorEject).toHaveBeenCalledWith(0);
  });

  it('refetches once for a burst of refusals, not once per refused request', async () => {
    const { queryClient } = renderWrapper();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const onRejected = await registeredRefusalHandler();
    await Promise.all([1, 2, 3, 4].map(() => onRejected(enrollmentRefusal()).catch(() => undefined)));

    expect(invalidate.mock.calls.filter(([arg]) => arg?.queryKey === ADMIN_SETTINGS_QUERY_KEY)).toHaveLength(1);
  });

  it('handles a refusal again once the refetch settles, even if it still reads enforcement off', async () => {
    // The refusing server instance can be ahead of the one answering the settings refetch.
    adminSettings.enforceMFA = 'false';
    try {
      const { queryClient } = renderWrapper();
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const adminSettingsRefetches = () =>
        invalidate.mock.calls.filter(([arg]) => arg?.queryKey === ADMIN_SETTINGS_QUERY_KEY).length;

      const onRejected = await registeredRefusalHandler();
      await onRejected(enrollmentRefusal()).catch(() => undefined);
      expect(adminSettingsRefetches()).toBe(1);

      await Promise.allSettled(invalidate.mock.results.map(r => r.value));
      await new Promise(resolve => setTimeout(resolve, 0));

      await onRejected(enrollmentRefusal()).catch(() => undefined);
      expect(adminSettingsRefetches()).toBe(2);
    } finally {
      adminSettings.enforceMFA = 'true';
    }
  });

  it('renders the enrollment flow when the refusal arrives but the status query has failed', async () => {
    // The status endpoint is down; only the server's 403 reveals that this session owes enrollment.
    get.mockRejectedValue(new Error('status unavailable'));
    renderWrapper();

    // Fail-open precondition: with no refusal observed, the app is left alone.
    expect(await screen.findByTestId('app-content')).not.toBeNull();

    const onRejected = await registeredRefusalHandler();
    await onRejected(enrollmentRefusal()).catch(() => undefined);

    await screen.findByTestId('mfa-enforcement-required-screen');
    expect(screen.queryByTestId('app-content')).toBeNull();
    // The flow is usable, not just visible: setup is attempted.
    await waitFor(() => expect(mfaSetupCalls()).toBeGreaterThanOrEqual(1));
  });
});

describe('MFAEnforcementWrapper - failed setup verification', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockResolvedValue({ data: { enabled: false } });
    post.mockImplementation((url: string) =>
      url === '/api/auth/mfa/setup'
        ? Promise.resolve({ data: { qrCodeUrl: 'qr', manualEntryKey: 'key', backupCodes: [] } })
        : Promise.reject({ response: { data: { error: 'Invalid code', attemptsRemaining: 2 } } })
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the error inline with the attempts remaining, and still toasts it', async () => {
    renderWrapper();

    fireEvent.click(await screen.findByTestId('mfa-modal-stub-verify'));

    await waitFor(() =>
      expect(screen.getByTestId('mfa-modal-stub-error').textContent).toBe('Invalid code (2 attempts remaining)')
    );
    expect(toastError).toHaveBeenCalledWith('Invalid code (2 attempts remaining)');
    expect(screen.getByTestId('mfa-modal-stub').getAttribute('data-mode')).toBe('setup');
  });

  it('clears the inline error when the user retries', async () => {
    renderWrapper();
    fireEvent.click(await screen.findByTestId('mfa-modal-stub-verify'));
    await waitFor(() => expect(screen.getByTestId('mfa-modal-stub-error').textContent).not.toBe(''));

    post.mockImplementation(() => new Promise(() => {})); // the retry stays in flight
    fireEvent.click(screen.getByTestId('mfa-modal-stub-verify'));
    await waitFor(() => expect(screen.getByTestId('mfa-modal-stub-error').textContent).toBe(''));
  });
});

describe('MFAEnforcementWrapper - an enrolled user is never sent into setup', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    get.mockResolvedValue({ data: { enabled: false } });
    post.mockResolvedValue({ data: { qrCodeUrl: 'qr', manualEntryKey: 'key', backupCodes: [] } });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // The mocked currentUser has no `mfa`, as after a reload rehydrates the persisted user store.
  it('trusts the status query over a currentUser that lacks mfa', async () => {
    get.mockResolvedValue({ data: { enabled: true } });

    renderWrapper();

    await screen.findByTestId('app-content');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(mfaSetupCalls()).toBe(0);
  });

  it('refreshes status instead of toasting when setup answers 409', async () => {
    get.mockResolvedValueOnce({ data: { enabled: false } }).mockResolvedValue({ data: { enabled: true } });
    post.mockRejectedValue(
      Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'MFA is already enabled for this account.' } },
      })
    );

    renderWrapper();

    await screen.findByTestId('app-content');
    expect(mfaSetupCalls()).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
  });
});

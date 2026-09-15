import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, waitFor, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// api layer: MFA status resolves (so enforcement logic runs), but /api/auth/mfa/setup
// PERSISTENTLY fails - the exact condition that used to spin the auto-setup effect forever.
const post = vi.fn();
const get = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { post: (...args: unknown[]) => post(...args), get: (...args: unknown[]) => get(...args) },
  isPublicPath: () => false,
}));

// enforceMFA on, admin settings loaded.
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({ settings: { enforceMFA: 'true' }, isLoading: false }),
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

// Keep the modal + toasts inert so the test focuses on the effect's call behavior.
vi.mock('@client/app/components/common/MFAModal', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import MFAEnforcementWrapper from './MFAEnforcementWrapper';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <CssVarsProvider theme={appTheme}>
      <QueryClientProvider client={queryClient}>
        <MFAEnforcementWrapper>
          <div data-testid="app-content" />
        </MFAEnforcementWrapper>
      </QueryClientProvider>
    </CssVarsProvider>
  );
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

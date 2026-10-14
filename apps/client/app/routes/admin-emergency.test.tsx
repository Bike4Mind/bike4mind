// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

type MfaHookOptions = {
  onComplete: (result: { accessToken: string; user: unknown }) => void;
  onCancel?: (mode: 'verify' | 'setup') => void;
};

const mocks = vi.hoisted(() => ({
  apiPost: vi.fn(),
  navigate: vi.fn(),
  setCurrentUser: vi.fn(),
  mfa: { options: null as MfaHookOptions | null, begin: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.apiPost } }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: null, setCurrentUser: mocks.setCurrentUser }),
}));
vi.mock('@client/app/hooks/useMfaChallenge', () => ({
  useMfaChallenge: (options: MfaHookOptions) => {
    mocks.mfa.options = options;
    return { begin: mocks.mfa.begin, modalProps: { open: false } };
  },
}));
vi.mock('@client/app/components/common/MFAModal', () => ({ default: () => null }));

import AdminEmergencyPage from './admin-emergency';

const appTheme = extendTheme({ ...getThemeConfig() });

async function submitCredentials() {
  const user = userEvent.setup();
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminEmergencyPage />
    </CssVarsProvider>
  );
  await user.type(screen.getByTestId('admin-emergency-username-input'), 'root');
  await user.type(screen.getByTestId('admin-emergency-password-input'), 'hunter2');
  await user.click(screen.getByTestId('admin-emergency-login-btn'));
}

describe('admin emergency login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mfa.options = null;
  });

  it('hands the password-verified response to the second-factor challenge', async () => {
    mocks.apiPost.mockResolvedValue({
      data: { userId: 'admin-1', accessToken: 'pending-tok', passkeyAvailable: true },
    });

    await submitCredentials();

    await waitFor(() => expect(mocks.mfa.begin).toHaveBeenCalledTimes(1));
    expect(mocks.apiPost).toHaveBeenCalledWith('/api/admin/emergency-login', { username: 'root', password: 'hunter2' });
    expect(mocks.mfa.begin).toHaveBeenCalledWith({
      userId: 'admin-1',
      mfaToken: 'pending-tok',
      mode: 'verify',
      passkeyAvailable: true,
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.setCurrentUser).not.toHaveBeenCalled();
  });

  it('never begins a challenge when the credentials are rejected', async () => {
    mocks.apiPost.mockRejectedValue({ response: { status: 401, data: { message: 'Nope' } } });

    await submitCredentials();

    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(mocks.mfa.begin).not.toHaveBeenCalled();
  });

  it('stores the user and opens the admin panel only once the challenge completes', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminEmergencyPage />
      </CssVarsProvider>
    );
    expect(mocks.navigate).not.toHaveBeenCalled();

    act(() => mocks.mfa.options!.onComplete({ accessToken: 'full', user: { id: 'admin-1' } }));

    expect(mocks.setCurrentUser).toHaveBeenCalledWith({ id: 'admin-1' });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/admin', search: { emergency_access: 'true' } });
  });
});

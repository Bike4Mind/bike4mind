import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const h = vi.hoisted(() => ({
  active: true,
  mutate: vi.fn(),
  post: vi.fn(),
  refetch: vi.fn(),
  state: { expiresAt: new Date(Date.now() + 60_000).toISOString(), writeEnabled: false },
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (select: (state: unknown) => unknown) => select({ impersonating: h.active, accessToken: 'token' }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { name: 'Customer' } }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useReturnToAdmin: () => ({ mutate: h.mutate }) }));
vi.mock('@client/app/contexts/apiClient', () => ({ api: { post: h.post } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: h.state, refetch: h.refetch }) }));
import { ImpersonationBanner } from './ImpersonationBanner';
const theme = extendTheme({ ...getThemeConfig() });
const mount = () =>
  render(
    <CssVarsProvider theme={theme}>
      <ImpersonationBanner />
    </CssVarsProvider>
  );

describe('global impersonation banner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.active = true;
    h.state = { expiresAt: new Date(Date.now() + 60_000).toISOString(), writeEnabled: false };
  });
  it('shows identity, readonly mode, time and an accessible End on any route', () => {
    for (const path of ['/new', '/files', '/settings']) {
      window.history.replaceState({}, '', path);
      const view = mount();
      expect(screen.getByTestId('impersonation-banner')).toHaveAttribute('aria-label', 'Support access session');
      expect(screen.getByText('Viewing as Customer')).toBeTruthy();
      expect(screen.getByText(/Read-only.*min remaining/)).toBeTruthy();
      fireEvent.click(screen.getByTestId('impersonation-end-btn'));
      view.unmount();
    }
    expect(h.mutate).toHaveBeenCalledTimes(3);
  });
  it('requires a validated reason in the shared escalation dialog', async () => {
    mount();
    fireEvent.click(screen.getByTestId('impersonation-allow-btn'));
    expect(screen.getByTestId('impersonation-escalate-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('impersonation-escalate-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('impersonation-escalate-dialog-confirm-btn'));
    expect(h.post).toHaveBeenCalledWith('/api/auth/impersonation', { reason: 'Reproduce a reported bug' });
  });
  it('automatically returns to admin at expiry, once', () => {
    h.state.expiresAt = new Date(0).toISOString();
    mount();
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });
  it('is absent for ordinary sessions', () => {
    h.active = false;
    mount();
    expect(screen.queryByTestId('impersonation-banner')).toBeNull();
  });
});

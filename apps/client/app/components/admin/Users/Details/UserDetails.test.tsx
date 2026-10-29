import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { AxiosError, type AxiosResponse } from 'axios';
import { toast } from 'sonner';
import UserDetails from './UserDetails';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({ resetMutate: vi.fn(), post: vi.fn() }));

vi.mock('@client/app/hooks/data/mfa', () => ({
  useForceResetMFA: () => ({ mutate: h.resetMutate, isPending: false }),
}));
vi.mock('./GrantSubscriptionModal', () => ({ default: () => null }));
vi.mock('./AdminGenerateApiKeyModal', () => ({ default: () => null }));
vi.mock('./AdminApiKeysModal', () => ({ default: () => null }));
vi.mock('../MFAStatusBadge', () => ({ default: () => null }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));

const appTheme = extendTheme({ ...getThemeConfig() });
const queryClient = new QueryClient();
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const user = {
  id: 'u1',
  name: 'Ada',
  username: 'ada',
  email: 'ada@example.com',
  mfa: { totpEnabled: true, setupAt: new Date('2026-01-01').toISOString() },
} as unknown as AdminUserListItem;

describe('UserDetails - MFA reset reason', () => {
  it('requires a valid reason and sends it with the reset request', async () => {
    render(<UserDetails user={user} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByRole('button', { name: /reset mfa/i }));
    const confirmButton = screen.getByTestId('mfa-reset-confirm-btn');
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('mfa-reset-reason-input'), { target: { value: 'Lost phone, verified by ID' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    await waitFor(() => expect(h.resetMutate).toHaveBeenCalledTimes(1));
    expect(h.resetMutate.mock.calls[0][0]).toEqual({ userId: 'u1', reason: 'Lost phone, verified by ID' });
  });
});

describe('UserDetails - API key trust toggle', () => {
  beforeEach(() => {
    h.post.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  const reasonInput = () => screen.getByTestId('user-details-reason-modal-reason-input');
  const reasonConfirm = () => screen.getByTestId('user-details-reason-modal-confirm-btn');

  it('reflects the current approval and posts the new value with a reason only after confirming', async () => {
    h.post.mockResolvedValue({ data: { apiKeyTrustApproved: true } });
    render(<UserDetails user={user} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    const toggle = screen.getByTestId('admin-user-api-key-trust-toggle');
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(h.post).not.toHaveBeenCalled();
    expect(reasonConfirm()).toBeDisabled();
    fireEvent.change(reasonInput(), { target: { value: 'Known integration partner' } });
    fireEvent.click(reasonConfirm());

    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/admin/users/u1/api-key-trust', {
        approved: true,
        reason: 'Known integration partner',
      })
    );
    await waitFor(() => expect(screen.getByTestId('admin-user-api-key-trust-toggle')).toBeChecked());
  });

  it('leaves the switch and the server alone when the reason dialog is cancelled', () => {
    render(<UserDetails user={user} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('admin-user-api-key-trust-toggle'));
    fireEvent.click(screen.getByTestId('user-details-reason-modal-cancel-btn'));

    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-user-api-key-trust-toggle')).not.toBeChecked();
  });

  it('posts approved: false with the reason when an approved user is untrusted', async () => {
    h.post.mockResolvedValue({ data: { apiKeyTrustApproved: false } });
    const trusted = { ...user, apiKeyTrustApproved: true } as AdminUserListItem;
    render(<UserDetails user={trusted} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('admin-user-api-key-trust-toggle'));
    fireEvent.change(reasonInput(), { target: { value: 'Suspicious usage seen' } });
    fireEvent.click(reasonConfirm());

    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/api/admin/users/u1/api-key-trust', {
        approved: false,
        reason: 'Suspicious usage seen',
      })
    );
  });

  it('starts checked for an already-trusted user', () => {
    const trusted = { ...user, apiKeyTrustApproved: true } as AdminUserListItem;
    render(<UserDetails user={trusted} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    expect(screen.getByTestId('admin-user-api-key-trust-toggle')).toBeChecked();
  });

  it('toasts the server error string when the trust request fails, and leaves the switch unchecked', async () => {
    const serverMessage = 'Cannot approve: user email is not verified';
    h.post.mockRejectedValue(
      new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        data: { error: serverMessage },
      } as AxiosResponse)
    );
    render(<UserDetails user={user} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByTestId('admin-user-api-key-trust-toggle'));
    fireEvent.change(reasonInput(), { target: { value: 'Known integration partner' } });
    fireEvent.click(reasonConfirm());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(serverMessage));
    expect(screen.getByTestId('admin-user-api-key-trust-toggle')).not.toBeChecked();
  });
});

describe('UserDetails - email verification reason', () => {
  beforeEach(() => h.post.mockReset().mockResolvedValue({ data: {} }));

  it.each([
    ['Verify Email', { ...user, emailVerified: false }, 'verify-email'],
    ['Unverify Email', { ...user, emailVerified: true }, 'unverify-email'],
  ])('%s asks for a reason and posts it', async (label, target, endpoint) => {
    render(<UserDetails user={target as unknown as AdminUserListItem} editedFields={{}} onFieldChange={vi.fn()} />, {
      wrapper: TestWrapper,
    });

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`, 'i') }));

    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByTestId('user-details-reason-modal-confirm-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('user-details-reason-modal-reason-input'), {
      target: { value: 'Ownership confirmed by support' },
    });
    fireEvent.click(screen.getByTestId('user-details-reason-modal-confirm-btn'));

    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith(`/api/admin/users/u1/${endpoint}`, {
        reason: 'Ownership confirmed by support',
      })
    );
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getThemeConfig } from '@client/app/utils/themes';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import UserDetails from './UserDetails';

const h = vi.hoisted(() => ({ resetMutate: vi.fn() }));

vi.mock('@client/app/hooks/data/mfa', () => ({
  useForceResetMFA: () => ({ mutate: h.resetMutate, isPending: false }),
}));
vi.mock('./GrantSubscriptionModal', () => ({ default: () => null }));
vi.mock('./AdminGenerateApiKeyModal', () => ({ default: () => null }));
vi.mock('./AdminApiKeysModal', () => ({ default: () => null }));
vi.mock('../MFAStatusBadge', () => ({ default: () => null }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn() } }));

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
  it('requires a valid reason and sends it with the reset request', () => {
    render(<UserDetails user={user} editedFields={{}} onFieldChange={vi.fn()} />, { wrapper: TestWrapper });

    fireEvent.click(screen.getByRole('button', { name: /reset mfa/i }));
    const confirmButton = screen.getByTestId('mfa-reset-confirm-btn');
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByTestId('mfa-reset-reason-input'), { target: { value: 'Lost phone, verified by ID' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);

    expect(h.resetMutate).toHaveBeenCalledTimes(1);
    expect(h.resetMutate.mock.calls[0][0]).toEqual({ userId: 'u1', reason: 'Lost phone, verified by ID' });
  });
});

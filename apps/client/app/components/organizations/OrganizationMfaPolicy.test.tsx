import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IOrganizationDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationMfaPolicy from './OrganizationMfaPolicy';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), userId: 'owner' }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put } }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: mocks.userId, isAdmin: false } }),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const org = {
  id: 'org',
  userId: 'owner',
  users: [{ userId: 'member', permissions: ['read'] }],
  adminUserIds: [],
} as unknown as IOrganizationDocument;
const theme = extendTheme({ ...getThemeConfig() });
const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <OrganizationMfaPolicy organization={org} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

describe('organization MFA policy controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userId = 'owner';
    mocks.get.mockResolvedValue({
      data: {
        policy: { required: true, graceDays: 7, enforceAfter: '2030-01-01T00:00:00.000Z' },
        members: [{ userId: 'owner', enrolled: false }],
      },
    });
    mocks.put.mockResolvedValue({ data: {} });
  });
  it('loads the grace period, offers enrollment and saves the selected policy', async () => {
    mount();
    await waitFor(() =>
      expect((screen.getByTestId('organization-mfa-grace-input') as HTMLInputElement).value).toBe('7')
    );
    expect(await screen.findByTestId('organization-mfa-enrollment-alert')).toBeTruthy();
    fireEvent.change(screen.getByTestId('organization-mfa-grace-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('organization-mfa-save-btn'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/organizations/org/mfa-policy', { required: true, graceDays: 0 })
    );
  });
  it('does not expose a save control to ordinary members', async () => {
    mocks.userId = 'member';
    mount();
    await screen.findByTestId('organization-mfa-enrollment-alert');
    expect(screen.queryByTestId('organization-mfa-save-btn')).toBeNull();
  });
  it('disables saving an out-of-range grace period', async () => {
    mount();
    await screen.findByTestId('organization-mfa-enrollment-alert');
    fireEvent.change(screen.getByTestId('organization-mfa-grace-input'), { target: { value: '31' } });
    expect((screen.getByTestId('organization-mfa-save-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});

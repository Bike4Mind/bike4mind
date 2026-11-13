import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument } from '@bike4mind/common';
import OrganizationMfaPolicy from './OrganizationMfaPolicy';

const mocks = vi.hoisted(() => ({ userId: 'owner', get: vi.fn(), put: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { id: mocks.userId } }) }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, put: mocks.put } }));
const theme = extendTheme({ ...getThemeConfig() });
const org = {
  id: 'team',
  userId: 'owner',
  personal: false,
  users: [],
  adminUserIds: [],
} as unknown as IOrganizationDocument;
function renderPolicy() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <OrganizationMfaPolicy organization={org} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'owner';
  mocks.get.mockResolvedValue({
    data: {
      members: [
        { id: 'one', name: 'One', mfaEnabled: true },
        { id: 'two', name: 'Two', mfaEnabled: false },
      ],
    },
  });
  mocks.put.mockResolvedValue({ data: {} });
});
describe('OrganizationMfaPolicy', () => {
  it('shows status and saves the login-only policy with grace', async () => {
    renderPolicy();
    await waitFor(() => expect(screen.getByTestId('organization-mfa-member-one').textContent).toContain('MFA enabled'));
    expect(screen.getByTestId('organization-mfa-member-two').textContent).toContain('MFA not enabled');
    fireEvent.click(screen.getByTestId('organization-mfa-required'));
    fireEvent.change(screen.getByTestId('organization-mfa-grace-days'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('organization-mfa-save'));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/api/organizations/team/mfa-policy', { required: true, graceDays: 3 })
    );
  });
  it('retains the failed draft and permits retry after a rejected save', async () => {
    mocks.put.mockRejectedValueOnce(new Error('offline'));
    renderPolicy();
    fireEvent.click(screen.getByTestId('organization-mfa-required'));
    fireEvent.change(screen.getByTestId('organization-mfa-grace-days'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('organization-mfa-save'));
    await waitFor(() => expect(screen.getByTestId('organization-mfa-required')).not.toBeDisabled());
    expect(screen.getByTestId('organization-mfa-required')).toBeChecked();
    expect(screen.getByTestId('organization-mfa-grace-days')).toHaveValue(3);
    fireEvent.change(screen.getByTestId('organization-mfa-grace-days'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('organization-mfa-save'));
    await waitFor(() => expect(mocks.put).toHaveBeenCalledTimes(2));
    expect(mocks.put).toHaveBeenLastCalledWith('/api/organizations/team/mfa-policy', { required: true, graceDays: 4 });
  });
  it('hides controls and does not fetch status for ordinary members', () => {
    mocks.userId = 'member';
    renderPolicy();
    expect(screen.queryByTestId('organization-mfa-policy')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });
  it('does not save an invalid grace period', () => {
    renderPolicy();
    fireEvent.click(screen.getByTestId('organization-mfa-required'));
    fireEvent.change(screen.getByTestId('organization-mfa-grace-days'), { target: { value: '31' } });
    expect((screen.getByTestId('organization-mfa-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

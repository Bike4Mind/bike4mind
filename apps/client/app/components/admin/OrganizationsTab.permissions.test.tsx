import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IUserDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { useUser } from '@client/app/contexts/UserContext';
import OrganizationsTab from './OrganizationsTab';

vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

const mocks = vi.hoisted(() => ({ topUp: vi.fn(), create: vi.fn(), grant: vi.fn(), toast: vi.fn() }));
vi.mock('@client/app/contexts/UserContext', async () => {
  const { create } = await import('zustand');
  return { useUser: create(() => ({ currentUser: null })) };
});
vi.mock('sonner', () => ({ toast: { error: mocks.toast, success: vi.fn() } }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({ useTeamSeatLimits: () => ({ maxSeats: 100 }) }));
vi.mock('@client/app/hooks/data/user', () => ({ useGetPendingOrganizationUsers: () => ({ data: [] }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSearchOrganizations: () => ({
    data: {
      data: [{ id: 'org1', name: 'Example', users: [], seats: 4, currentCredits: 20, personal: false }],
      totalPages: 1,
    },
    refetch: vi.fn(),
    isLoading: false,
  }),
  useCreateOrganization: () => ({ mutateAsync: mocks.create }),
}));
vi.mock('@client/app/hooks/data/adminOrganizations', () => ({
  useAdminOrgGrants: () => ({ data: [{ ownerId: 'org1' }] }),
  useGrantOrganization: () => ({ mutateAsync: mocks.grant }),
  useTopUpOrganization: () => ({ mutateAsync: mocks.topUp }),
  useAdjustOrgSeats: () => ({ mutateAsync: vi.fn() }),
  useConvertOrgToPaid: () => ({ mutateAsync: vi.fn() }),
  useReconcileOrgSeats: () => ({ mutateAsync: vi.fn() }),
  useRevokeOrganization: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('./OrganizationProfileModal', () => ({ default: () => null }));
vi.mock('@client/app/components/organizations/Member', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/SearchBar', () => ({ default: () => null }));
vi.mock('@client/app/components/admin/Subscriptions/components/PaginationControls', () => ({ default: () => null }));
const theme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => <CssVarsProvider theme={theme}>{children}</CssVarsProvider>;
const actor = (permissions: string[]) =>
  ({ id: 'operator', adminPermissions: ['support:read', ...permissions] }) as IUserDocument;
const renderTab = () => render(<OrganizationsTab />, { wrapper: Wrapper });
const openActions = () => fireEvent.click(screen.getByTestId('org-actions-org1'));
const openTopUp = () => {
  openActions();
  fireEvent.click(screen.getByTestId('topup-credits-org1'));
  fireEvent.change(screen.getByTestId('org-topup-reason-input'), { target: { value: 'Customer compensation' } });
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.topUp.mockResolvedValue({});
  useUser.setState({ currentUser: actor(['settings:manage']) });
});
describe('organization admin action permissions', () => {
  it('disables billing actions for settings-only operators with named permissions', () => {
    renderTab();
    expect(screen.getByTestId('admin-org-create-open')).toBeEnabled();
    expect(screen.getByTestId('admin-org-grant-open')).toBeDisabled();
    openActions();
    for (const action of ['topup-credits', 'adjust-seats', 'convert-to-paid', 'revoke-grant']) {
      expect(screen.getByTestId(`${action}-org1`)).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId(`${action}-org1`)).toHaveAttribute('title', 'Missing permission: credits:adjust');
    }
  });
  it('allows credit operations while disabling organization settings and members', async () => {
    useUser.setState({ currentUser: actor(['credits:adjust']) });
    renderTab();
    expect(screen.getByTestId('admin-org-create-open')).toBeDisabled();
    expect(screen.getByTestId('admin-org-edit-org1')).toBeDisabled();
    expect(screen.getByTestId('admin-org-members-org1')).toBeDisabled();
    expect(screen.getByTestId('admin-org-grant-open')).toBeEnabled();
    openTopUp();
    fireEvent.click(screen.getByTestId('topup-submit'));
    await waitFor(() =>
      expect(mocks.topUp).toHaveBeenCalledWith({
        organizationId: 'org1',
        credits: 50000,
        reason: 'Customer compensation',
      })
    );
  });
  it('rechecks the current store before an already-open billing confirmation submits', () => {
    useUser.setState({ currentUser: actor(['credits:adjust']) });
    renderTab();
    openTopUp();
    const submit = screen.getByTestId('topup-submit');
    act(() => {
      useUser.setState({ currentUser: actor(['settings:manage']) });
      fireEvent.click(submit);
    });
    expect(mocks.topUp).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('Missing permission: credits:adjust');
  });
  it('rechecks settings before a previously-open create dialog submits', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-org-create-open'));
    fireEvent.change(screen.getByTestId('org-name-input').querySelector('input')!, {
      target: { value: 'New organization' },
    });
    const submit = screen.getByTestId('create-org-submit');
    act(() => {
      useUser.setState({ currentUser: actor(['credits:adjust']) });
      fireEvent.click(submit);
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith('Missing permission: settings:manage');
  });
});

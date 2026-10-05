import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, Permission } from '@bike4mind/common';
import OrganizationMembers from './Member';

const mocks = vi.hoisted(() => ({ viewerId: 'viewer' }));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: mocks.viewerId, isAdmin: false } }),
}));
vi.mock('@client/app/hooks/data/user', () => ({
  useGetOrganizationUsers: () => ({ data: [] }),
  useGetPendingOrganizationUsers: () => ({ data: [] }),
  useGetUsers: () => ({ data: undefined, isFetching: false }),
}));
vi.mock('@client/app/hooks/data/invites', () => ({ useShareDocument: () => ({ mutate: vi.fn() }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrganizationSeats: () => ({ maxSeats: 0, currentSeats: 0, availableSeats: 0 }),
  useSetMemberCreditDefault: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./UserCard', () => ({ default: () => null }));
vi.mock('@client/app/components/common/GenericAddItemsModal', () => ({ default: () => null }));
vi.mock('@client/app/components/common/UserCard', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

const buildOrg = (overrides: Partial<IOrganizationDocument>) =>
  ({
    id: 'org1',
    userId: 'owner1',
    adminUserIds: [],
    users: [],
    userDetails: [],
    maxCreditsPerMember: 500,
    ...overrides,
  }) as unknown as IOrganizationDocument;

const renderMembers = (organization: IOrganizationDocument) =>
  render(<OrganizationMembers organization={organization} userPermissions={[Permission.read]} />, {
    wrapper: TestWrapper,
  });

describe('OrganizationMembers credit budget control', () => {
  beforeEach(() => {
    mocks.viewerId = 'viewer';
  });

  it('is offered to an appointed admin who holds a read-only users[] row', () => {
    renderMembers(
      buildOrg({
        adminUserIds: ['viewer'],
        users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'],
      })
    );
    expect(screen.getByTestId('member-credit-budget-edit-btn')).toBeTruthy();
  });

  it('is hidden from a plain member', () => {
    renderMembers(
      buildOrg({ users: [{ userId: 'viewer', permissions: [Permission.read] }] as IOrganizationDocument['users'] })
    );
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
  });

  it('is hidden from a listed admin who no longer has a users[] row', () => {
    renderMembers(buildOrg({ adminUserIds: ['viewer'] }));
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
  });
});

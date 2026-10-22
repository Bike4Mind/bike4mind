import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import OrganizationListPage from './index';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  memberOrganizations: [] as Array<Record<string, unknown>>,
  teamPlanAvailable: true,
  openCreateTeamModal: vi.fn(),
}));

vi.mock('@client/app/hooks/data/teamPlanSettings', () => ({
  useTeamPlanAvailable: () => mocks.teamPlanAvailable,
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'manager1', isAdmin: false } }),
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useGetUserOrganizations: () => ({ data: mocks.memberOrganizations, isLoading: false, isFetching: false }),
  useOrganizationSeats: () => ({ currentSeats: 2 }),
}));
vi.mock('@client/app/hooks/data/subscriptions', () => ({ useGetSubscriptionsByOwner: () => ({ data: [] }) }));
vi.mock('@client/app/components/organizations/CreateTeamModal', () => ({
  useCreateTeamModal: () => mocks.openCreateTeamModal,
}));
vi.mock('@client/app/components/help', () => ({ ContextHelpButton: () => null }));
vi.mock('@client/app/hooks/useDocumentTitle', () => ({ useDocumentTitle: () => undefined }));
vi.mock('@client/app/utils/s3', () => ({ getAppFileUrl: () => '' }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const theme = extendTheme({ ...getThemeConfig() });

describe('Teams list for an appointed manager', () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.openCreateTeamModal.mockReset();
    mocks.teamPlanAvailable = true;
    mocks.memberOrganizations = [
      {
        id: 'org1',
        userId: 'owner1',
        adminUserIds: ['manager1'],
        name: 'Managed Team',
        personal: false,
        seats: 4,
        currentCredits: 100,
      },
    ];
  });

  it('opens the Create Team modal when enableTeamPlan is on', () => {
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationListPage />
      </CssVarsProvider>
    );

    const button = screen.getByTestId('organizations-create-team-btn');
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(mocks.openCreateTeamModal).toHaveBeenCalledTimes(1);
  });

  it('offers a public administration preview without a Team or an available subscription', () => {
    mocks.teamPlanAvailable = false;
    mocks.memberOrganizations = [];
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationListPage />
      </CssVarsProvider>
    );

    const preview = screen.getByTestId('organizations-admin-preview-link');
    expect(preview.tagName).toBe('A');
    expect(preview.getAttribute('href')).toBe('https://docs.bike4mind.com/features/team-admin-preview');
    expect(preview.textContent).toBe('Preview Team administration');
    expect(screen.getByText('organization.no_organizations')).toBeTruthy();
    expect(screen.getByTestId('organizations-create-team-btn').hasAttribute('disabled')).toBe(true);
    expect(mocks.openCreateTeamModal).not.toHaveBeenCalled();
  });

  it('keeps Create Team visible but disabled when enableTeamPlan is off', () => {
    mocks.teamPlanAvailable = false;
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationListPage />
      </CssVarsProvider>
    );

    const button = screen.getByTestId('organizations-create-team-btn');
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(mocks.openCreateTeamModal).not.toHaveBeenCalled();
  });

  it('offers a team the user manages as a navigable Team card', () => {
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationListPage />
      </CssVarsProvider>
    );

    expect(screen.getByText('Managed Team')).toBeTruthy();
    expect(screen.getByText('Manager')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'organization.view_details' }));
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/organizations/org1' });
  });

  it('lists teams once each, sorted by name', () => {
    mocks.memberOrganizations = [
      { id: 'org2', userId: 'owner2', name: 'Alpha Team', personal: false, seats: 2, currentCredits: 10 },
      {
        id: 'org1',
        userId: 'owner1',
        adminUserIds: ['manager1'],
        name: 'Managed Team',
        personal: false,
        seats: 4,
        currentCredits: 100,
      },
    ];
    render(
      <CssVarsProvider theme={theme}>
        <OrganizationListPage />
      </CssVarsProvider>
    );

    expect(screen.getAllByText('Managed Team')).toHaveLength(1);
    const alpha = screen.getByText('Alpha Team');
    const managed = screen.getByText('Managed Team');
    expect(alpha.compareDocumentPosition(managed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

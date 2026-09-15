import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, IUserDocument } from '@bike4mind/common';
import OrganizationSettingsSection from './OrganizationSettingsSection';

const currentUser = vi.fn();

vi.mock('@client/app/hooks/data/organizations', () => ({
  useDeleteOrganization: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateOrganization: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@client/app/hooks/useConfirmation', () => ({
  useConfirmationModal: { setState: vi.fn() },
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: currentUser() }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const OWNER_ID = 'owner1';
const appTheme = extendTheme({ ...getThemeConfig() });

// The billing owner is deliberately not in users[] - the server never puts them there.
const org = {
  id: 'org1',
  name: 'Acme',
  userId: OWNER_ID,
  users: [{ userId: 'member1', permissions: ['update'] }],
} as unknown as IOrganizationDocument;

const renderAs = (user: Partial<IUserDocument> | null) => {
  currentUser.mockReturnValue(user);
  const wrapper = (children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>;
  return render(wrapper(<OrganizationSettingsSection organization={org} />));
};

/**
 * The Danger Zone mirrors the server gate in organizationService/delete.ts (billing owner or
 * platform admin). The rest of this tab is open to anyone with org update/share, so these pin that
 * a member who can reach the tab is not shown a Delete button whose call would 403.
 */
describe('OrganizationSettingsSection - Danger Zone visibility', () => {
  it('shows Delete Organization to the billing owner', () => {
    renderAs({ id: OWNER_ID, isAdmin: false });

    expect(screen.getByTestId('organization-settings-delete-btn')).toBeTruthy();
  });

  it('shows Delete Organization to a platform admin', () => {
    renderAs({ id: 'platform1', isAdmin: true });

    expect(screen.getByTestId('organization-settings-delete-btn')).toBeTruthy();
  });

  it('hides Delete Organization from a member who can otherwise manage the org', () => {
    renderAs({ id: 'member1', isAdmin: false });

    expect(screen.queryByTestId('organization-settings-delete-btn')).toBeNull();
    // The rest of the tab still renders for them.
    expect(screen.getByText('Team System Prompt')).toBeTruthy();
  });

  it('hides Delete Organization when there is no resolved user', () => {
    renderAs(null);

    expect(screen.queryByTestId('organization-settings-delete-btn')).toBeNull();
  });
});

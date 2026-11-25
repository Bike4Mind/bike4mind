import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IOrganizationDocument } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { OrganizationSharingSettings } from './OrganizationSharingSettings';

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn(), user: { id: 'owner' } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: mocks.user }) }));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useUpdateOrganization: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));
const org = { id: 'org', userId: 'owner', users: [], name: 'Team' } as unknown as IOrganizationDocument;
const theme = extendTheme({ ...getThemeConfig() });
const show = () =>
  render(
    <CssVarsProvider theme={theme}>
      <OrganizationSharingSettings organization={org} />
    </CssVarsProvider>
  );

beforeEach(() => {
  mocks.user = { id: 'owner' };
  mocks.mutateAsync.mockReset().mockResolvedValue({});
});
describe('organization sharing settings', () => {
  it('saves public/external restrictions and normalized domain exceptions', async () => {
    show();
    fireEvent.click(screen.getByTestId('organization-sharing-public-switch'));
    fireEvent.click(screen.getByTestId('organization-sharing-external-switch'));
    fireEvent.change(screen.getByTestId('organization-sharing-domains-input'), {
      target: { value: 'Partner.Example, other.example' },
    });
    fireEvent.click(screen.getByTestId('organization-sharing-save-btn'));
    await waitFor(() =>
      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        orgId: 'org',
        data: {
          sharingPolicy: {
            allowPublicLinks: false,
            allowExternalSharing: false,
            allowedDomains: ['partner.example', 'other.example'],
          },
        },
      })
    );
  });
  it('explains why ordinary members cannot change policy', () => {
    mocks.user = { id: 'member' };
    show();
    expect(screen.getByText('Only organization owners and managers can change sharing policy.')).toBeTruthy();
    expect(screen.getByTestId('organization-sharing-save-btn').hasAttribute('disabled')).toBe(true);
  });
  it('refuses invalid domain input and explains the required format', () => {
    show();
    fireEvent.change(screen.getByTestId('organization-sharing-domains-input'), { target: { value: '*.example.com' } });
    expect(screen.getByText('Enter an email domain, without @ or a URL')).toBeTruthy();
    expect(screen.getByTestId('organization-sharing-save-btn').hasAttribute('disabled')).toBe(true);
  });
});

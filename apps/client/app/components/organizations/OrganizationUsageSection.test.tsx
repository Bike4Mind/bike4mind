import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrganizationDocument } from '@bike4mind/common';
import OrganizationUsageSection from './OrganizationUsageSection';

vi.mock('@client/app/components/admin/CreditAnalysis/components/UsageDashboard', () => ({
  UsageDashboard: () => <div data-testid="usage-dashboard-stub" />,
}));
vi.mock('@client/app/components/admin/CreditAnalysis/components/TransactionLedger', () => ({
  TransactionLedger: () => <div data-testid="ledger-stub" />,
}));
const viewer = vi.hoisted(() => ({ current: { id: 'owner-1', isAdmin: false } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: viewer.current }) }));
vi.mock('./OrganizationStorageUsage', () => ({
  default: ({ organizationId }: { organizationId: string }) => (
    <div data-testid="storage-panel-stub">{organizationId}</div>
  ),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const organization = {
  id: 'org-7',
  userId: 'owner-1',
  billingManagerUserIds: ['billing-1'],
  users: [{ userId: 'billing-1' }],
} as unknown as IOrganizationDocument;

const renderSection = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <OrganizationUsageSection organization={organization} />
    </CssVarsProvider>
  );

describe('OrganizationUsageSection', () => {
  beforeEach(() => {
    viewer.current = { id: 'owner-1', isAdmin: false };
  });

  it('opens on Usage and switches to the Ledger tab', () => {
    renderSection();
    expect(screen.getByTestId('usage-dashboard-stub')).toBeTruthy();

    fireEvent.click(screen.getByTestId('org-ledger-tab'));
    expect(screen.getByTestId('ledger-stub')).toBeTruthy();
  });

  it('shows the storage panel for the org on the Storage tab', () => {
    renderSection();

    fireEvent.click(screen.getByTestId('org-storage-tab'));
    expect(screen.getByTestId('storage-panel-stub').textContent).toBe('org-7');
  });

  // Storage reads are manageContent (verifyOrgAdminRead); a billing manager holds only viewUsage.
  it('hides the Storage tab from a billing manager', () => {
    viewer.current = { id: 'billing-1', isAdmin: false };
    renderSection();

    expect(screen.getByTestId('org-usage-tab')).toBeTruthy();
    expect(screen.queryByTestId('org-storage-tab')).toBeNull();
  });
});

import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument, WithId } from '@bike4mind/common';
import OrganizationProfileUpdated from './OrganizationProfileUpdated';

const mutateAsync = vi.fn();
vi.mock('@client/app/hooks/data/organizations', () => ({
  useUpdateOrganization: () => ({ mutateAsync, isPending: false }),
}));
vi.mock('@client/app/hooks/data/useOrgStorageUsage', () => ({
  useOrgStorageUsage: () => ({ data: { usedBytes: 0, limitBytes: 50_000_000 }, isError: false }),
}));
vi.mock('./OrganizationGroupTypesCard', () => ({ default: () => null }));
vi.mock('./OrganizationGroupMembersCard', () => ({ default: () => null }));
// Stubbed here because it reads the router.
vi.mock('./Billing/OrganizationBillingSection', () => ({
  OrganizationBillingSection: ({ orgId }: { orgId: string }) => <div data-testid="stub-org-billing">{orgId}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const makeOrg = (overrides: Partial<IOrganizationDocument> = {}): WithId<IOrganizationDocument> =>
  ({ id: 'org1', name: 'Acme', users: [], personal: false, ...overrides }) as WithId<IOrganizationDocument>;

const renderModal = (org: WithId<IOrganizationDocument>) =>
  render(<OrganizationProfileUpdated org={org} onClose={vi.fn()} activeDays={30} />, { wrapper: Wrapper });

const setLimit = (value: string) =>
  fireEvent.change(screen.getByTestId('admin-org-storage-limit-input'), { target: { value } });

const sentData = () => mutateAsync.mock.calls[0][0].data;

describe('OrganizationProfileUpdated - billing', () => {
  it('shows the read-only billing overview for this organization', () => {
    renderModal(makeOrg());
    expect(screen.getByTestId('stub-org-billing')).toHaveTextContent('org1');
  });
});

describe('OrganizationProfileUpdated - storage limit', () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
  });

  it('prefills the current limit', () => {
    renderModal(makeOrg({ storageLimit: 50 }));

    expect(screen.getByTestId('admin-org-storage-limit-input')).toHaveValue('50');
  });

  it('sends a changed fractional limit as a number', () => {
    renderModal(makeOrg({ storageLimit: 50 }));

    setLimit('0.5');
    fireEvent.click(screen.getByTestId('admin-org-update-btn'));

    expect(sentData().storageLimit).toBe(0.5);
  });

  it('sends null when the limit is cleared', () => {
    renderModal(makeOrg({ storageLimit: 50 }));

    setLimit('');
    fireEvent.click(screen.getByTestId('admin-org-update-btn'));

    expect(sentData().storageLimit).toBeNull();
  });

  it('compares a second save in the same session against the last saved value, not the opening snapshot', async () => {
    renderModal(makeOrg());

    setLimit('500');
    fireEvent.click(screen.getByTestId('admin-org-update-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));

    setLimit('');
    fireEvent.click(screen.getByTestId('admin-org-update-btn'));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));

    expect(mutateAsync.mock.calls[1][0].data.storageLimit).toBeNull();
  });

  it('blocks malformed text instead of reading it as a clear', () => {
    renderModal(makeOrg({ storageLimit: 500 }));

    setLimit('5e');

    expect(screen.getByTestId('admin-org-update-btn')).toBeDisabled();
  });

  it('omits storageLimit when it was not changed', () => {
    renderModal(makeOrg());

    fireEvent.click(screen.getByTestId('admin-org-update-btn'));

    expect('storageLimit' in sentData()).toBe(false);
  });

  it('blocks the update on an invalid limit', () => {
    renderModal(makeOrg());

    setLimit('-1');

    expect(screen.getByTestId('admin-org-update-btn')).toBeDisabled();
  });

  it('keeps a changed credit balance out of the settings save', () => {
    renderModal(makeOrg({ currentCredits: 100 }));
    fireEvent.change(screen.getByTestId('org-profile-credits-input'), { target: { value: '200' } });
    fireEvent.click(screen.getByTestId('admin-org-update-btn'));

    expect(sentData()).not.toHaveProperty('currentCredits');
    expect(sentData()).not.toHaveProperty('creditReason');
  });

  it('adjusts credits through the audited action dialog with a before/after preview', async () => {
    renderModal(makeOrg({ currentCredits: 100 }));
    fireEvent.change(screen.getByTestId('org-profile-credits-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('org-profile-adjust-credits-btn'));

    expect(screen.getByTestId('org-profile-credit-preview-before')).toHaveTextContent('100');
    expect(screen.getByTestId('org-profile-credit-preview-after')).toHaveTextContent('0');
    expect(screen.getByTestId('org-profile-credit-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-profile-credit-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('org-profile-credit-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        orgId: 'org1',
        data: { currentCredits: 0, creditReason: 'Goodwill credit' },
      })
    );
  });
});

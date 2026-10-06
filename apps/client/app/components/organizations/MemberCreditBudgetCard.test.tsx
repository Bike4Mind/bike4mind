import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { IOrganizationDocument } from '@bike4mind/common';
import MemberCreditBudgetCard from './MemberCreditBudgetCard';

const mutateAsync = vi.fn();
vi.mock('@client/app/hooks/data/organizations', () => ({
  useSetMemberCreditDefault: () => ({ mutateAsync, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const org = (maxCreditsPerMember: number | null) =>
  ({ id: 'org1', name: 'Acme', userId: 'owner1', maxCreditsPerMember }) as unknown as IOrganizationDocument;
const renderCard = (organization: IOrganizationDocument, canManage: boolean) =>
  render(
    ((children: ReactNode) => <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>)(
      <MemberCreditBudgetCard organization={organization} canManage={canManage} />
    )
  );

describe('MemberCreditBudgetCard', () => {
  beforeEach(() => {
    mutateAsync.mockReset().mockResolvedValue({});
  });

  it('shows the limit in force to a member who cannot change it, without an edit control', () => {
    renderCard(org(500), false);
    expect(screen.getByTestId('member-credit-budget-summary').textContent).toContain('up to 500 credits per month');
    expect(screen.queryByTestId('member-credit-budget-edit-btn')).toBeNull();
  });

  it('renders nothing for a member who cannot change it when no limit is set', () => {
    renderCard(org(null), false);
    expect(screen.queryByTestId('member-credit-budget-card')).toBeNull();
  });

  it('lets a manager set a limit when none exists', async () => {
    renderCard(org(null), true);
    expect(screen.getByTestId('member-credit-budget-summary').textContent).toContain('No limit');

    fireEvent.click(screen.getByTestId('member-credit-budget-edit-btn'));
    fireEvent.change(screen.getByTestId('credit-limit-input'), { target: { value: '750' } });
    fireEvent.click(screen.getByTestId('credit-limit-save-btn'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', maxCreditsPerMember: 750 }));
  });

  it('refuses a 0 default (would freeze every member) and lets a manager remove the limit', async () => {
    renderCard(org(500), true);
    fireEvent.click(screen.getByTestId('member-credit-budget-edit-btn'));

    fireEvent.change(screen.getByTestId('credit-limit-input'), { target: { value: '0' } });
    expect(screen.getByTestId('credit-limit-save-btn')).toHaveProperty('disabled', true);

    fireEvent.click(screen.getByTestId('credit-limit-clear-btn'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ organizationId: 'org1', maxCreditsPerMember: null })
    );
  });
});

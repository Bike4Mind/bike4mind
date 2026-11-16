import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IOrgBudgetAlerts } from '@bike4mind/common';
import OrgBudgetAlertsCard from './OrgBudgetAlertsCard';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  saved: null as IOrgBudgetAlerts | null,
}));
vi.mock('@client/app/hooks/data/organizations', () => ({
  useOrgAlertSettings: () => ({ data: mocks.saved, isSuccess: true }),
  useUpdateOrgAlertSettings: () => ({ mutate: mocks.mutate, isPending: false }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);
const renderCard = () => render(<OrgBudgetAlertsCard organizationId="org1" />, { wrapper: TestWrapper });
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;

describe('OrgBudgetAlertsCard', () => {
  beforeEach(() => {
    mocks.mutate.mockReset();
    mocks.saved = null;
  });

  it('starts disabled with the default 50/80/100 thresholds when nothing is saved', () => {
    renderCard();
    expect(input('org-alerts-enable-switch').checked).toBe(false);
    for (const value of [50, 80, 100]) expect(screen.getByTestId(`org-alerts-threshold-${value}-chip`)).toBeTruthy();
    expect(input('org-alerts-budget-input').value).toBe('');
  });

  it('renders saved values and saves the edited settings', () => {
    mocks.saved = { enabled: true, monthlyBudgetCredits: 10000, percentThresholds: [80], lowBalanceCredits: null };
    renderCard();
    expect(input('org-alerts-enable-switch').checked).toBe(true);
    expect(input('org-alerts-budget-input').value).toBe('10000');
    expect(screen.queryByTestId('org-alerts-threshold-50-chip')).toBeNull();

    fireEvent.click(screen.getByTestId('org-alerts-threshold-80-remove-btn'));
    fireEvent.change(input('org-alerts-threshold-input'), { target: { value: '90' } });
    fireEvent.click(screen.getByTestId('org-alerts-threshold-add-btn'));
    fireEvent.change(input('org-alerts-threshold-input'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('org-alerts-threshold-add-btn'));
    fireEvent.change(input('org-alerts-low-balance-input'), { target: { value: '0' } });
    fireEvent.click(screen.getByTestId('org-alerts-save-btn'));

    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      organizationId: 'org1',
      budgetAlerts: { enabled: true, monthlyBudgetCredits: 10000, percentThresholds: [25, 90], lowBalanceCredits: 0 },
    });
  });

  it('sends null for cleared amounts and saves the enable toggle', () => {
    mocks.saved = { enabled: false, monthlyBudgetCredits: 500, percentThresholds: [], lowBalanceCredits: 100 };
    renderCard();
    fireEvent.click(input('org-alerts-enable-switch'));
    fireEvent.change(input('org-alerts-budget-input'), { target: { value: '' } });
    fireEvent.change(input('org-alerts-low-balance-input'), { target: { value: ' ' } });
    fireEvent.click(screen.getByTestId('org-alerts-save-btn'));

    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      organizationId: 'org1',
      budgetAlerts: { enabled: true, monthlyBudgetCredits: null, percentThresholds: [], lowBalanceCredits: null },
    });
  });

  it('blocks save on a zero or non-numeric budget, and refuses out-of-range or duplicate thresholds', () => {
    renderCard();
    fireEvent.change(input('org-alerts-budget-input'), { target: { value: '0' } });
    expect(input('org-alerts-save-btn').disabled).toBe(true);
    fireEvent.change(input('org-alerts-budget-input'), { target: { value: '12.5' } });
    expect(input('org-alerts-save-btn').disabled).toBe(true);
    fireEvent.change(input('org-alerts-budget-input'), { target: { value: '100' } });
    expect(input('org-alerts-save-btn').disabled).toBe(false);

    for (const bad of ['0', '101', '80', 'abc']) {
      fireEvent.change(input('org-alerts-threshold-input'), { target: { value: bad } });
      expect(input('org-alerts-threshold-add-btn').disabled).toBe(true);
    }
  });

  it('stops adding thresholds at the cap of five', () => {
    mocks.saved = {
      enabled: true,
      monthlyBudgetCredits: 100,
      percentThresholds: [10, 20, 30, 40, 50],
      lowBalanceCredits: null,
    };
    renderCard();
    fireEvent.change(input('org-alerts-threshold-input'), { target: { value: '60' } });
    expect(input('org-alerts-threshold-add-btn').disabled).toBe(true);
  });
  it.each(['9'.repeat(400), '9007199254740992'])('rejects unsafe credit amounts', value => {
    renderCard();
    fireEvent.change(input('org-alerts-budget-input'), { target: { value } });
    expect(input('org-alerts-save-btn')).toBeDisabled();
    fireEvent.click(input('org-alerts-save-btn'));
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('explains enabled alerts without an effective threshold', () => {
    mocks.saved = { enabled: true, monthlyBudgetCredits: null, percentThresholds: [80], lowBalanceCredits: null };
    renderCard();
    expect(screen.getByRole('status')).toHaveTextContent('No effective thresholds');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CreditAnalyticsTab } from './index';
import { useCreditAnalysisStore } from './store';

const { stub } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
}));
vi.mock('./components/UserCreditsManager', () => ({ UserCreditsManager: stub('stub-user-credits') }));
vi.mock('./components/ModelPricingCatalog', () => ({ ModelPricingCatalog: stub('stub-pricing') }));
vi.mock('./components/MarginDashboard', () => ({ MarginDashboard: stub('stub-margins') }));
vi.mock('./components/UsageDashboard', () => ({ UsageDashboard: stub('stub-org-usage') }));
vi.mock('./components/PlatformUsageDashboard', () => ({ PlatformUsageDashboard: stub('stub-api-usage') }));
vi.mock('./components/TransactionLedger', () => ({ TransactionLedger: stub('stub-ledger') }));
vi.mock('./components/CreditAdjustmentsLog', () => ({ CreditAdjustmentsLog: stub('stub-adjustments') }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });

describe('CreditAnalyticsTab', () => {
  it('shows the stored inner tab and records a switch in the store', () => {
    useCreditAnalysisStore.getState().setActiveTab('users');
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('stub-user-credits')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('credit-analysis-ledger-tab'));

    expect(useCreditAnalysisStore.getState().activeTab).toBe('ledger');
    expect(screen.getByTestId('stub-ledger')).toBeInTheDocument();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CreditAnalyticsTab } from './index';
import { useCreditAnalysisStore } from './store';

const { stub, search, navigate } = vi.hoisted(() => ({
  stub: (id: string) => () => <div data-testid={id} />,
  search: { creditView: undefined as string | undefined, creditTab: undefined as string | undefined },
  navigate: vi.fn(),
}));
vi.mock('./components/UserCreditsManager', () => ({ UserCreditsManager: stub('stub-user-credits') }));
vi.mock('./components/MarginDashboard', () => ({ MarginDashboard: stub('stub-margins') }));
vi.mock('./components/UsageDashboard', () => ({ UsageDashboard: stub('stub-org-usage') }));
vi.mock('./components/PlatformUsageDashboard', () => ({ PlatformUsageDashboard: stub('stub-api-usage') }));
vi.mock('./components/SideAppsDashboard', () => ({ SideAppsDashboard: stub('stub-side-apps') }));
vi.mock('./components/ElevenLabsDashboard', () => ({ ElevenLabsDashboard: stub('stub-elevenlabs') }));
vi.mock('./components/TransactionLedger', () => ({ TransactionLedger: stub('stub-ledger') }));
vi.mock('./components/CreditAdjustmentsAuditLink', () => ({ CreditAdjustmentsAuditLink: stub('stub-adjustments') }));
vi.mock('./components/CreditEconomy', () => ({ CreditEconomy: stub('stub-economy') }));
vi.mock('@tanstack/react-router', () => ({ useSearch: () => search, useNavigate: () => navigate }));
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
    expect(screen.getByRole('heading', { level: 1, name: 'Credits' })).toBeInTheDocument();
    expect(screen.getByTestId('admin-page-header').nextElementSibling).toContainElement(
      screen.getByTestId('credit-analysis-ledger-tab')
    );
    for (const [id, label] of Object.entries({
      users: 'User credits',
      economy: 'Economy',
      margins: 'Margins',
      'org-usage': 'Org usage',
      'api-usage': 'API usage',
      'side-apps': 'Side apps',
      elevenlabs: 'ElevenLabs',
      ledger: 'Ledger',
      adjustments: 'Adjustments',
    })) {
      const tab = screen.getByTestId(`credit-analysis-${id}-tab`);
      expect(tab).toHaveTextContent(label);
      expect(tab.querySelector('svg')).toBeNull();
    }

    fireEvent.click(screen.getByTestId('credit-analysis-ledger-tab'));

    expect(useCreditAnalysisStore.getState().activeTab).toBe('ledger');
    expect(screen.getByTestId('stub-ledger')).toBeInTheDocument();
  });

  it('has no Model pricing tab', () => {
    useCreditAnalysisStore.getState().setActiveTab('users');
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );

    expect(screen.queryByTestId('credit-analysis-pricing-tab')).toBeNull();
    expect(screen.queryByText('Model Pricing')).toBeNull();
  });

  it('opens Economy from its deep link over the stored inner tab', () => {
    search.creditView = 'economy';
    useCreditAnalysisStore.getState().setActiveTab('users');
    const { unmount } = render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );

    expect(screen.getByTestId('stub-economy')).toBeInTheDocument();
    unmount();
    search.creditView = undefined;
  });

  it('opens the Side apps sub-tab from its deep link and drops an unknown value', () => {
    search.creditTab = 'side-apps';
    useCreditAnalysisStore.getState().setActiveTab('users');
    const { unmount } = render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('stub-side-apps')).toBeInTheDocument();
    unmount();

    search.creditTab = 'nope';
    useCreditAnalysisStore.getState().setActiveTab('users');
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('stub-user-credits')).toBeInTheDocument();
    search.creditTab = undefined;
  });

  it('renders the linked sub-tab first, before the effect syncs the store', () => {
    const { setActiveTab } = useCreditAnalysisStore.getState();
    useCreditAnalysisStore.setState({ activeTab: 'users', setActiveTab: () => {} });
    search.creditTab = 'side-apps';
    try {
      render(
        <CssVarsProvider theme={appTheme}>
          <CreditAnalyticsTab />
        </CssVarsProvider>
      );
      expect(useCreditAnalysisStore.getState().activeTab).toBe('users');
      expect(screen.getByTestId('credit-analysis-side-apps-tab')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('credit-analysis-users-tab')).toHaveAttribute('aria-selected', 'false');
      expect(screen.queryByTestId('stub-user-credits')).toBeNull();
      expect(screen.getByTestId('stub-side-apps')).toBeInTheDocument();
    } finally {
      search.creditTab = undefined;
      useCreditAnalysisStore.setState({ setActiveTab });
    }
  });

  it('writes the sub-tab to the URL on selection and leaves the default out', () => {
    navigate.mockClear();
    useCreditAnalysisStore.getState().setActiveTab('users');
    render(
      <CssVarsProvider theme={appTheme}>
        <CreditAnalyticsTab />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('credit-analysis-side-apps-tab'));
    const update = navigate.mock.calls.at(-1)?.[0].search as (previous: object) => Record<string, unknown>;
    expect(update({})).toMatchObject({ creditTab: 'side-apps' });
    fireEvent.click(screen.getByTestId('credit-analysis-users-tab'));
    const reset = navigate.mock.calls.at(-1)?.[0].search as (previous: object) => Record<string, unknown>;
    expect(reset({ creditTab: 'side-apps' }).creditTab).toBeUndefined();
  });
});

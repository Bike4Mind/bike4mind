import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] = [];
let settingsLoading = false;
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: serverSettings, isLoading: settingsLoading }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFloorAboveMeasuredWarning: () => undefined,
}));
vi.mock('./ScopedSettingOverrides', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

import { settingsMap } from '@bike4mind/common';
import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';
import AdminGrowthPricingTab, {
  GROWTH_PRICING_LINKS,
  GROWTH_PRICING_SECTIONS,
  RATE_LIMIT_SETTING_KEYS,
  RATE_LIMIT_SETTINGS_SEARCH,
} from './AdminGrowthPricingTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderTab = () =>
  render(
    <TestWrapper>
      <AdminGrowthPricingTab />
    </TestWrapper>
  );

beforeEach(() => {
  serverSettings = [];
  settingsLoading = false;
  fakeAdminRouter.reset({ tab: 'growth-pricing' });
  useCreditAnalysisStore.setState({ activeTab: 'users' });
  useAdminModal.setState({ activeTab: AdminTab.GrowthPricing });
});

describe('AdminGrowthPricingTab', () => {
  it('groups every growth and pricing knob on one page', () => {
    renderTab();

    for (const section of GROWTH_PRICING_SECTIONS) {
      expect(screen.getByTestId(`admin-growth-pricing-section-${section.id}`)).toBeTruthy();
    }
    const keys = GROWTH_PRICING_SECTIONS.flatMap(section => section.keys);
    expect(keys).toEqual(
      expect.arrayContaining([
        'defaultFreeCredits',
        'allowOpenRegistration',
        'ReferralCreditsAmount',
        'enableTeamPlan',
        'enforceCredits',
        'pricePerCredit',
        'teamPlanMinSeats',
        'teamPlanMaxSeats',
        'teamPlanCreditsPerSeat',
        'lowCreditsThreshold',
      ])
    );
    for (const key of keys) {
      expect(screen.getByTestId(`admin-setting-${key}-save-btn`)).toBeTruthy();
    }
  });

  it('shows defaults when nothing is stored, and the stored value once one is', () => {
    serverSettings = [{ settingName: 'teamPlanMaxSeats', settingValue: 250 }];
    renderTab();

    expect(screen.getByTestId('admin-growth-pricing-current-teamPlanMinSeats').textContent).toBe(
      'Current: 4 (default)'
    );
    expect(screen.getByTestId('admin-growth-pricing-current-teamPlanMaxSeats').textContent).toBe(
      'Current: 250 - default 100'
    );
    const maxInput = screen.getByTestId('admin-setting-teamPlanMaxSeats-input') as HTMLInputElement;
    expect(maxInput.value).toBe('250');
    // The schema's bounds reach the editor, so the browser offers the range the server accepts.
    expect(maxInput.min).toBe('1');
    expect(screen.getByTestId('admin-setting-teamPlanCreditsPerSeat-input')).toHaveProperty('value', '50000');
  });

  it('warns when the stored minimum seats exceed the maximum', () => {
    serverSettings = [
      { settingName: 'teamPlanMinSeats', settingValue: 20 },
      { settingName: 'teamPlanMaxSeats', settingValue: 10 },
    ];
    renderTab();

    const warnings = screen.getAllByTestId('admin-growth-pricing-warning').map(el => el.textContent);
    expect(warnings.some(text => text?.includes('Team Plan Minimum Seats (20) is above the maximum (10)'))).toBe(true);
  });

  it('warns that starter credits are inert while open registration is off', () => {
    serverSettings = [{ settingName: 'defaultFreeCredits', settingValue: 5000 }];
    renderTab();

    const warnings = screen.getAllByTestId('admin-growth-pricing-warning').map(el => el.textContent);
    expect(warnings.some(text => text?.includes('no effect while Allow Open Registration is off'))).toBe(true);
  });

  it('shows no warnings at defaults', () => {
    renderTab();
    expect(screen.queryByTestId('admin-growth-pricing-warning')).toBeNull();
  });

  it('links to the model pricing catalog and the tier rate-limit settings', () => {
    renderTab();

    for (const link of GROWTH_PRICING_LINKS) {
      expect(screen.getByTestId(`admin-growth-pricing-section-${link.id}`)).toBeTruthy();
      expect(screen.getByTestId(`admin-growth-pricing-link-${link.id}`).textContent).toBe(link.linkLabel);
    }
  });

  it('links without rendering a second editor for any setting', () => {
    renderTab();

    for (const key of RATE_LIMIT_SETTING_KEYS) {
      expect(screen.queryByTestId(`admin-setting-${key}-save-btn`)).toBeNull();
    }
    const keys = GROWTH_PRICING_SECTIONS.flatMap(section => section.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('opens Credit Analytics on its Model Pricing tab', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-growth-pricing-link-model-pricing'));

    expect(useCreditAnalysisStore.getState().activeTab).toBe('pricing');
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.CreditAnalytics);
  });

  it('opens Admin Settings filtered to the rate-limit group', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-growth-pricing-link-rate-limits'));

    expect(fakeAdminRouter.search).toEqual({
      tab: 'admin-settings',
      section: 'security',
      q: RATE_LIMIT_SETTINGS_SEARCH,
    });
    expect(RATE_LIMIT_SETTING_KEYS.length).toBeGreaterThan(0);
    for (const key of RATE_LIMIT_SETTING_KEYS) {
      expect(key).toContain(RATE_LIMIT_SETTINGS_SEARCH);
      expect(settingsMap[key].category).toBe('SecOps');
    }
  });

  it('shows a loader until settings arrive', () => {
    settingsLoading = true;
    renderTab();
    expect(screen.getByTestId('admin-growth-pricing-loading')).toBeTruthy();
    expect(screen.queryByTestId('admin-growth-pricing-tab')).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] = [];
let settingsLoading = false;
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: serverSettings, isLoading: settingsLoading }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock('./ScopedSettingOverrides', () => ({ default: () => null }));

import AdminGrowthPricingTab, { GROWTH_PRICING_SECTIONS } from './AdminGrowthPricingTab';

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

  it('shows a loader until settings arrive', () => {
    settingsLoading = true;
    renderTab();
    expect(screen.getByTestId('admin-growth-pricing-loading')).toBeTruthy();
    expect(screen.queryByTestId('admin-growth-pricing-tab')).toBeNull();
  });
});

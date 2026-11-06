import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] | undefined = [];
let settingsLoading = false;
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: serverSettings, isLoading: settingsLoading }),
  useUpdateSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  useFloorAboveMeasuredWarning: () => undefined,
}));
vi.mock('./ScopedSettingOverrides', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', async () => (await import('./__tests__/fakeAdminRouter')).fakeRouterModule);

import { MIN_PRICE_PER_CREDIT_USD, formatUsdAmount, formatUsdPerCredit, settingsMap } from '@bike4mind/common';
import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';
import AdminGrowthPricingTab, {
  describeDerivedValue,
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
        'ReferralFirstAnswerCredits',
        'ReferralFirstPaymentCredits',
        'ReferralSecondPaymentCredits',
        'ReferralHoldDays',
        'ReferralInvitesPerUser',
        'ReferralAlertRewardsPerDay',
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

  it('values starter and referral credits in dollars at the floor rate', () => {
    serverSettings = [{ settingName: 'defaultFreeCredits', settingValue: 5000 }];
    renderTab();

    const floor = formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD);
    expect(screen.getByTestId('admin-growth-pricing-derived-defaultFreeCredits').textContent).toBe(
      `5,000 credits = ${formatUsdAmount(5000 * MIN_PRICE_PER_CREDIT_USD)} at the floor ${floor} per credit`
    );
    // Referral is at its default (10,000).
    expect(screen.getByTestId('admin-growth-pricing-derived-ReferralCreditsAmount').textContent).toBe(
      `10,000 credits = ${formatUsdAmount(10000 * MIN_PRICE_PER_CREDIT_USD)} at the floor ${floor} per credit`
    );
  });

  it('keeps every inviter reward off by default and values a stored reward in dollars', () => {
    serverSettings = [{ settingName: 'ReferralFirstPaymentCredits', settingValue: 6000 }];
    renderTab();

    expect(screen.getByTestId('admin-growth-pricing-current-ReferralFirstAnswerCredits').textContent).toBe(
      'Current: 0 (default)'
    );
    expect(screen.getByTestId('admin-growth-pricing-current-ReferralHoldDays').textContent).toBe(
      'Current: 14 (default)'
    );
    const floor = formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD);
    expect(screen.getByTestId('admin-growth-pricing-derived-ReferralFirstPaymentCredits').textContent).toBe(
      `6,000 credits = ${formatUsdAmount(6000 * MIN_PRICE_PER_CREDIT_USD)} at the floor ${floor} per credit`
    );
  });

  it('shows the unit and floor for the price per credit', () => {
    renderTab();
    expect(screen.getByTestId('admin-growth-pricing-derived-pricePerCredit').textContent).toBe(
      `$50 per credit (USD) - floor ${formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD)} per credit`
    );
  });

  it('derives nothing for settings that are not money', () => {
    expect(describeDerivedValue('teamPlanMaxSeats', 100)).toBeNull();
    expect(describeDerivedValue('defaultFreeCredits', 'abc')).toBeNull();
    expect(describeDerivedValue('defaultFreeCredits', '')).toBeNull();
    expect(describeDerivedValue('pricePerCredit', undefined)).toMatch(/^USD per credit - floor /);
  });

  it('links to the model pricing catalog and the tier rate-limit settings', () => {
    renderTab();

    for (const link of GROWTH_PRICING_LINKS) {
      expect(screen.getByTestId(`admin-growth-pricing-section-${link.id}`)).toBeTruthy();
      expect(screen.getByTestId(`admin-growth-pricing-link-${link.id}`).textContent).toBe(link.linkLabel);
    }
  });

  it('lists every credit pack and plan checkout sells, with no edit controls', () => {
    serverSettings = [
      { settingName: 'teamPlanCreditsPerSeat', settingValue: 1234 },
      { settingName: 'teamPlanMinSeats', settingValue: 3 },
      { settingName: 'teamPlanMaxSeats', settingValue: 40 },
    ];
    renderTab();

    const panel = screen.getByTestId('admin-growth-pricing-section-catalog');
    for (const pack of Object.values(CREDIT_PACKAGES)) {
      const row = within(panel).getByTestId(`admin-catalog-pack-row-${pack.id}`).textContent;
      expect(row).toContain(formatUsdAmount(pack.price));
      expect(row).toContain(pack.credits.toLocaleString('en-US'));
    }
    for (const plan of [...SUBSCRIPTION_PLANS, TEAM_PLAN]) {
      expect(within(panel).getByTestId(`admin-catalog-plan-row-${plan.name}`)).toBeTruthy();
    }
    expect(within(panel).getByTestId(`admin-catalog-plan-row-${TEAM_PLAN.name}`).textContent).toContain(
      '1,234 credits per seat, 3-40 seats'
    );
    for (const role of ['textbox', 'spinbutton', 'checkbox', 'switch']) {
      expect(within(panel).queryAllByRole(role)).toHaveLength(0);
    }
  });

  it('says the Team grant is unknown when settings could not be loaded', () => {
    serverSettings = undefined;
    renderTab();

    expect(screen.getByTestId(`admin-catalog-plan-row-${TEAM_PLAN.name}`).textContent).toContain(
      'Settings could not be loaded'
    );
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
    // Access policy shares the section, but this link opens only tier rate limits.
    expect(RATE_LIMIT_SETTING_KEYS).not.toContain('apiKeyAccess');
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

describe('AdminGrowthPricingTab enforceCredits lock', () => {
  const LOCKED_NOTE = 'Always on for hosted deployments';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('locks the toggle and Save on a hosted deployment and says why', () => {
    vi.stubEnv('B4M_SELF_HOST', undefined);
    renderTab();

    expect((screen.getByTestId('admin-setting-enforceCredits-switch') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('admin-setting-enforceCredits-save-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('admin-setting-enforceCredits-helper').textContent).toBe(LOCKED_NOTE);
  });

  it('leaves the toggle editable on a self-host deployment', () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    renderTab();

    expect((screen.getByTestId('admin-setting-enforceCredits-switch') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByTestId('admin-setting-enforceCredits-helper').textContent).not.toContain(LOCKED_NOTE);
  });

  it('does not lock any other setting', () => {
    vi.stubEnv('B4M_SELF_HOST', undefined);
    renderTab();

    expect(screen.getByTestId('admin-setting-pricePerCredit-helper').textContent).not.toContain(LOCKED_NOTE);
    expect((screen.getByTestId('admin-setting-allowOpenRegistration-switch') as HTMLInputElement).disabled).toBe(false);
  });
});

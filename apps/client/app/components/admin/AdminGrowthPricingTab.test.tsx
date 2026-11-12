import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@bike4mind/server-utils/lib/userSubscriptions/constants';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] | undefined = [];
let settingsLoading = false;
let settingsError = false;
type BlockerOptions = {
  enableBeforeUnload: boolean;
  shouldBlockFn(args: {
    current: { pathname: string; search: object };
    next: { pathname: string; search: object };
  }): boolean;
};
const mocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  refetch: vi.fn(),
  useBlocker: vi.fn<(options: BlockerOptions) => { status: string }>(() => ({ status: 'idle' })),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({
    data: serverSettings,
    isLoading: settingsLoading,
    isError: settingsError,
    isFetching: false,
    refetch: mocks.refetch,
  }),
  useUpdateSettings: () => ({ mutate: vi.fn(), mutateAsync: mocks.mutateAsync, isPending: false, error: null }),
  useFloorAboveMeasuredWarning: () => undefined,
}));
vi.mock('./ScopedSettingOverrides', () => ({ default: () => null }));
vi.mock('@tanstack/react-router', async () => ({
  ...(await import('./__tests__/fakeAdminRouter')).fakeRouterModule,
  useBlocker: mocks.useBlocker,
}));

import { MIN_PRICE_PER_CREDIT_USD, formatUsdAmount, formatUsdPerCredit, settingsMap } from '@bike4mind/common';
import { fakeAdminRouter } from './__tests__/fakeAdminRouter';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { REWARD_KEYS } from './settingHomes';
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

const lastBlocker = () => mocks.useBlocker.mock.lastCall?.[0];

const ALL_KEYS = GROWTH_PRICING_SECTIONS.flatMap(section => section.keys);

beforeEach(() => {
  serverSettings = [];
  settingsLoading = false;
  settingsError = false;
  mocks.mutateAsync.mockReset().mockResolvedValue({});
  mocks.refetch.mockReset();
  mocks.useBlocker.mockClear();
  useAdminModal.getState().setTabChangeGuard(null);
  fakeAdminRouter.reset({ tab: 'growth-pricing' });
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
        'allowOpenRegistration',
        'enableTeamPlan',
        'enforceCredits',
        'billOperationalUsage',
        'pricePerCredit',
        'teamPlanMinSeats',
        'teamPlanMaxSeats',
        'teamPlanCreditsPerSeat',
        'lowCreditsThreshold',
      ])
    );
    for (const key of keys) {
      expect(screen.getByTestId(`admin-setting-${key}-helper`)).toBeTruthy();
    }
    // Inviter rewards are edited in the Invite Center Rewards section.
    for (const key of REWARD_KEYS.referral) expect(keys, key).not.toContain(key);
    expect(screen.queryByTestId('admin-growth-pricing-section-referral-rewards')).toBeNull();
  });

  it('opens with the page header', () => {
    renderTab();

    const tab = screen.getByTestId('admin-growth-pricing-tab');
    const header = screen.getByTestId('admin-page-header');
    expect(tab.firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Growth and pricing');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(tab).toHaveStyle({ maxWidth: '1280px' });
  });

  it('renders each group as a section with no Card around it, leaving only the row cards', () => {
    renderTab();

    const tab = screen.getByTestId('admin-growth-pricing-tab');
    const ids = [
      ...GROWTH_PRICING_SECTIONS.map(section => section.id),
      'related',
      ...GROWTH_PRICING_LINKS.map(link => link.id),
    ];
    for (const id of ids) {
      const section = screen.getByTestId(`admin-growth-pricing-section-${id}`);
      expect(section.tagName).toBe('SECTION');
      expect(section.closest('.MuiCard-root')).toBeNull();
    }
    // The editor rows still draw their own card (AdminSettingInputField); none may sit in another card.
    for (const card of tab.querySelectorAll('.MuiCard-root')) {
      expect(card.parentElement?.closest('.MuiCard-root')).toBeNull();
    }
    for (const section of GROWTH_PRICING_SECTIONS) {
      expect(
        within(screen.getByTestId(`admin-growth-pricing-section-${section.id}`)).getByRole('heading', { level: 2 })
          .textContent
      ).toBe(section.title);
    }
    expect(
      within(screen.getByTestId('admin-growth-pricing-section-catalog')).getByRole('heading', { level: 2 }).textContent
    ).toBe('What checkout sells');
  });

  it('saves the page through one SaveBar instead of a Save button per field', async () => {
    renderTab();

    for (const key of ALL_KEYS) {
      expect(screen.queryByTestId(`admin-setting-${key}-save-btn`)).toBeNull();
    }
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();

    fireEvent.change(screen.getByTestId('admin-setting-teamPlanMaxSeats-input'), { target: { value: '300' } });
    expect(screen.getAllByTestId('admin-save-bar')).toHaveLength(1);
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('1 unsaved change');
    expect(mocks.mutateAsync).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('admin-setting-teamPlanCreditsPerSeat-input'), { target: { value: '1234' } });
    expect(screen.getByTestId('admin-save-bar').textContent).toContain('2 unsaved changes');

    // teamPlanCreditsPerSeat changes what customers pay, so the batch waits on the price warning.
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    const warning = await screen.findByTestId('admin-settings-warning-dialog');
    expect(warning).toHaveTextContent('Team Plan Credits Per Seat changes what customers pay');
    expect(mocks.mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('admin-settings-warning-save-btn'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
    expect(mocks.mutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'teamPlanMaxSeats', value: 300 });
    expect(mocks.mutateAsync).toHaveBeenCalledWith({ key: 'teamPlanCreditsPerSeat', value: 1234 });
  });

  it('discards staged edits without saving', () => {
    renderTab();
    const input = screen.getByTestId('admin-setting-teamPlanMaxSeats-input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '300' } });
    expect(input.value).toBe('300');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));

    expect(input.value).toBe('100');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    expect(mocks.mutateAsync).not.toHaveBeenCalled();
  });

  it('guards leaving the page while an edit is unsaved', () => {
    renderTab();
    const here = { pathname: '/admin', search: { tab: 'growth-pricing' } };
    const otherTab = { pathname: '/admin', search: { tab: 'admin-settings' } };

    expect(lastBlocker()?.enableBeforeUnload).toBe(false);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(false);
    expect(useAdminModal.getState().tabChangeGuard).toBeNull();

    fireEvent.change(screen.getByTestId('admin-setting-teamPlanMaxSeats-input'), { target: { value: '300' } });

    expect(lastBlocker()?.enableBeforeUnload).toBe(true);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: otherTab })).toBe(true);
    expect(lastBlocker()?.shouldBlockFn({ current: here, next: { pathname: '/', search: {} } })).toBe(true);
    // Sidebar switches go through the store; the provider routes them so the blocker sees them too.
    expect(useAdminModal.getState().tabChangeGuard).not.toBeNull();
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

  it('shows no editor and no warning for a stored Default Free Credits', () => {
    serverSettings = [{ settingName: 'defaultFreeCredits', settingValue: 5000 }];
    renderTab();

    expect(GROWTH_PRICING_SECTIONS.flatMap(section => section.keys)).not.toContain('defaultFreeCredits');
    expect(screen.queryByTestId('admin-growth-pricing-current-defaultFreeCredits')).toBeNull();
    expect(screen.queryByTestId('admin-growth-pricing-derived-defaultFreeCredits')).toBeNull();
    expect(screen.queryByTestId('admin-growth-pricing-warning')).toBeNull();
    expect(GROWTH_PRICING_SECTIONS.flatMap(section => section.keys)).not.toContain('ReferralCreditsAmount');
    expect(screen.queryByTestId('admin-growth-pricing-current-ReferralCreditsAmount')).toBeNull();
  });

  it('shows no warnings at defaults', () => {
    renderTab();
    expect(screen.queryByTestId('admin-growth-pricing-warning')).toBeNull();
  });

  it('values referral credits in dollars at the floor rate', () => {
    const floor = formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD);
    expect(describeDerivedValue('ReferralFirstAnswerCredits', 10000)).toBe(
      `10,000 credits = ${formatUsdAmount(10000 * MIN_PRICE_PER_CREDIT_USD)} at the floor ${floor} per credit`
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
    expect(describeDerivedValue('ReferralFirstAnswerCredits', 'abc')).toBeNull();
    expect(describeDerivedValue('ReferralFirstAnswerCredits', '')).toBeNull();
    expect(describeDerivedValue('pricePerCredit', undefined)).toMatch(/^USD per credit - floor /);
  });

  it('links to model prices, the tier rate-limit settings and the Invite Center rewards', () => {
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

  it('says the Team grant is unknown when the settings query has no data and no error', () => {
    serverSettings = undefined;
    renderTab();

    expect(screen.getByTestId(`admin-catalog-plan-row-${TEAM_PLAN.name}`).textContent).toContain(
      'Settings could not be loaded'
    );
  });

  it('links without rendering a second editor for any setting', () => {
    renderTab();

    for (const key of RATE_LIMIT_SETTING_KEYS) {
      for (const part of ['input', 'switch', 'helper']) {
        expect(screen.queryByTestId(`admin-setting-${key}-${part}`)).toBeNull();
      }
    }
    const keys = GROWTH_PRICING_SECTIONS.flatMap(section => section.keys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('opens Models > Prices', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-growth-pricing-link-model-pricing'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'models', modelsSection: 'prices' });
  });

  it('opens the Invite Center on its Rewards section', () => {
    renderTab();
    fireEvent.click(screen.getByTestId('admin-growth-pricing-link-invite-center-rewards'));

    expect(fakeAdminRouter.search).toEqual({ tab: 'waitlist', inviteSection: 'rewards' });
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

  it('shows a loader under the header until settings arrive', () => {
    settingsLoading = true;
    renderTab();
    expect(screen.getByTestId('admin-growth-pricing-loading').textContent).toBe('Loading growth and pricing settings');
    expect(screen.getByTestId('admin-page-header')).toBeTruthy();
    expect(screen.queryByTestId('admin-growth-pricing-section-signup')).toBeNull();
  });

  it('offers a retry when settings fail to load', () => {
    serverSettings = undefined;
    settingsError = true;
    renderTab();

    expect(screen.getByTestId('admin-error-state')).toBeTruthy();
    expect(screen.queryByTestId('admin-growth-pricing-section-signup')).toBeNull();
    expect(screen.queryByTestId('admin-setting-teamPlanMaxSeats-input')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('AdminGrowthPricingTab enforceCredits lock', () => {
  const LOCKED_NOTE = 'Always on for hosted deployments';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('locks the toggle on a hosted deployment and says why', () => {
    vi.stubEnv('B4M_SELF_HOST', undefined);
    renderTab();

    expect((screen.getByTestId('admin-setting-enforceCredits-switch') as HTMLInputElement).disabled).toBe(true);
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SETTING_TABS, settingsMap, type SettingKey } from '@bike4mind/common';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] = [];
let serverConfig: { hiddenAdminSettingKeys?: string[] } | undefined = { hiddenAdminSettingKeys: [] };
let isLoading = false;
let isError = false;
const refetchSettings = vi.fn();
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: serverSettings, isLoading, isError, refetch: refetchSettings }),
  useConfig: () => ({ data: serverConfig }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('./EmbeddingProviderLimits', () => ({ EmbeddingProviderLimits: () => null }));
vi.mock('./AdminSchemaSettingField', () => ({ default: () => null }));
vi.mock('./AdminTurnstileStatusNotice', () => ({
  AdminTurnstileStatusNotice: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="admin-turnstile-notice" data-enabled={String(enabled)} />
  ),
}));
vi.mock('./ScopedOverridesByScope', () => ({ ScopedOverridesByScope: () => null }));
vi.mock('./AdminLogoUpload', () => ({ default: () => null }));
vi.mock('./AdminSettingInputField', () => ({
  default: ({ setting, defaultValue }: { setting: { key: SettingKey }; defaultValue: unknown }) => (
    <div data-testid={`generic-setting-${setting.key}`} data-default-value={JSON.stringify(defaultValue)} />
  ),
}));
vi.mock('./AdminStringListSettingField', () => ({
  default: ({ setting, storedValue }: { setting: { key: SettingKey }; storedValue: unknown }) => (
    <div data-testid={`string-list-setting-${setting.key}`} data-stored-value={JSON.stringify(storedValue)} />
  ),
}));

type SearchRecord = Record<string, unknown>;
const router = vi.hoisted(() => ({ search: {} as Record<string, unknown>, navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({ state: { location: { pathname: '/admin', search: router.search } }, navigate: router.navigate }),
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}));

import AdminSettingsTab from './AdminSettingsTab';
import { HOME_BY_KEY, SETTING_HOMES } from './settingHomes';
import { GROWTH_PRICING_SECTIONS } from './AdminGrowthPricingTab';
import { MODEL_SETTINGS_ONLY_KEYS } from './Models/Settings/modelSettingsKeys';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { SEARCH_TERM_URL_DEBOUNCE_MS } from './shared/useAdminListUrlState';
import { AdminCommandPalette } from './shared/AdminCommandPalette';

/** The search the component's most recent navigate would produce from `previous`. */
const lastWrittenSearch = (previous: SearchRecord) => {
  const call = router.navigate.mock.calls.at(-1)?.[0] as {
    to: string;
    replace: boolean;
    search: (previous: SearchRecord) => SearchRecord;
  };
  expect(call.to).toBe('/admin');
  expect(call.replace).toBe(true);
  return call.search(previous);
};

const appTheme = extendTheme({ ...getThemeConfig() });

const settingsView = () => (
  <CssVarsProvider theme={appTheme}>
    <AdminSettingsTab />
  </CssVarsProvider>
);

const renderSettings = () => render(settingsView());

const findTab = (category: string) =>
  Object.values(SETTING_TABS).find(tab => (tab.categories as readonly string[]).includes(category));

const aiTab = findTab(settingsMap.videoGeneration.category);
const securityTab = findTab(settingsMap.ImageModerationReviewerEmails.category);
const usersTab = findTab(settingsMap.turnstileEnabled.category);

// The section comes from the URL, so seed it rather than click a tab: the mocked navigate does not
// write the search back.
const renderTab = (tab: typeof aiTab) => {
  expect(tab).toBeDefined();
  router.search = { tab: 'admin-settings', section: tab!.id };
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminSettingsTab />
    </CssVarsProvider>
  );
};

const renderAiTab = () => renderTab(aiTab);
const renderSecurityTab = () => renderTab(securityTab);

beforeEach(() => {
  isLoading = false;
  isError = false;
  refetchSettings.mockReset();
  serverSettings = [];
  serverConfig = { hiddenAdminSettingKeys: [] };
  router.search = {};
  router.navigate.mockReset();
});

describe('AdminSettingsTab URL state', () => {
  it('starts with the page header and keeps text labels on every section tab', () => {
    renderSettings();
    expect(screen.getByTestId('admin-settings-page').firstElementChild).toBe(screen.getByTestId('admin-page-header'));
    for (const tab of Object.values(SETTING_TABS)) {
      expect(screen.getByTestId(`admin-settings-section-tab-${tab.id}`)).toHaveTextContent(tab.name);
      expect(screen.getByTestId(`admin-settings-section-tab-${tab.id}`).querySelector('svg')).toBeNull();
    }
  });

  it('keeps the page header visible while settings load', () => {
    isLoading = true;
    renderSettings();
    expect(screen.getByTestId('admin-settings-page').firstElementChild).toBe(screen.getByTestId('admin-page-header'));
    expect(screen.getByText('Loading settings')).toBeInTheDocument();
  });

  it('shows an inline error with a retry action', () => {
    isError = true;
    renderSettings();
    expect(screen.getByText('Could not load settings.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(refetchSettings).toHaveBeenCalledOnce();
  });

  it('offers to clear a search with no matches', () => {
    router.search = { tab: 'admin-settings', q: 'zzzz-no-setting-matches' };
    renderSettings();
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No settings match these filters');
    fireEvent.click(screen.getByTestId('admin-settings-clear-filters-btn'));
    expect(screen.getByTestId('admin-settings-search-input')).toHaveValue('');
  });

  it('focuses the real settings search with /', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <div data-admin-surface>
          <AdminCommandPalette />
          <AdminSettingsTab />
        </div>
      </CssVarsProvider>
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('admin-settings-search-input')).toHaveFocus();
  });

  const sections = Object.values(SETTING_TABS);
  const [firstSection, secondSection] = sections;
  const isSelected = (id: string) =>
    screen.getByTestId(`admin-settings-section-tab-${id}`).getAttribute('aria-selected') === 'true';

  it('opens the section named by ?section=', () => {
    router.search = { tab: 'admin-settings', section: secondSection.id };
    renderSettings();
    expect(isSelected(secondSection.id)).toBe(true);
    expect(isSelected(firstSection.id)).toBe(false);
  });

  it('falls back to the first section for an unknown ?section=', () => {
    router.search = { tab: 'admin-settings', section: 'constructor' };
    renderSettings();
    expect(isSelected(firstSection.id)).toBe(true);
  });

  it('writes the section id to the URL, keeping the other params', () => {
    renderSettings();
    fireEvent.click(screen.getByTestId(`admin-settings-section-tab-${secondSection.id}`));
    expect(lastWrittenSearch({ tab: 'admin-settings', q: 'slack' })).toEqual({
      tab: 'admin-settings',
      q: 'slack',
      section: secondSection.id,
    });
  });

  it('seeds the search box from ?q= and writes edits back once typing pauses, removing q once cleared', () => {
    vi.useFakeTimers();
    try {
      router.search = { tab: 'admin-settings', q: 'slack' };
      renderSettings();
      const input = screen.getByTestId('admin-settings-search-input') as HTMLInputElement;
      expect(input.value).toBe('slack');

      fireEvent.change(input, { target: { value: 'slack b' } });
      fireEvent.change(input, { target: { value: 'slack bot' } });
      expect(input.value).toBe('slack bot');
      expect(router.navigate).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS));
      expect(router.navigate).toHaveBeenCalledTimes(1);
      expect(lastWrittenSearch({ tab: 'admin-settings', q: 'slack' })).toEqual({
        tab: 'admin-settings',
        q: 'slack bot',
      });

      fireEvent.change(input, { target: { value: '' } });
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS));
      expect(lastWrittenSearch({ tab: 'admin-settings', q: 'slack bot' })).toEqual({
        tab: 'admin-settings',
        q: undefined,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending search write when the tab unmounts', () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderSettings();
      fireEvent.change(screen.getByTestId('admin-settings-search-input'), { target: { value: 'slack' } });
      unmount();
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS));
      expect(router.navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a pending search write when ?q= changes from outside first', () => {
    vi.useFakeTimers();
    try {
      router.search = { tab: 'admin-settings', q: 'slack' };
      const { rerender } = renderSettings();
      const input = screen.getByTestId('admin-settings-search-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'slack bot' } });

      router.search = { tab: 'admin-settings', q: 'billing' };
      rerender(settingsView());
      act(() => vi.advanceTimersByTime(SEARCH_TERM_URL_DEBOUNCE_MS));
      expect(input.value).toBe('billing');
      expect(router.navigate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-seeds the search box when ?q= changes from outside while mounted', () => {
    router.search = { tab: 'admin-settings', q: 'slack' };
    const { rerender } = renderSettings();
    const input = screen.getByTestId('admin-settings-search-input') as HTMLInputElement;
    expect(input.value).toBe('slack');

    // e.g. back/forward landing on the same tab with no q.
    router.search = { tab: 'admin-settings' };
    rerender(settingsView());
    expect(input.value).toBe('');
  });
});

describe('AdminSettingsTab model settings', () => {
  const moved = [...MODEL_SETTINGS_ONLY_KEYS];

  it('covers the discovery, default, free-tier and generation keys', () => {
    for (const key of [
      'enableModelDiscovery',
      'modelDiscoveryMode',
      'DefaultAPIModel',
      'recommendedModelIds',
      'freeTierModelGateEnabled',
      'freeTierAllowedModels',
      'videoGeneration',
      'musicGeneration',
    ] as const) {
      expect(MODEL_SETTINGS_ONLY_KEYS.has(key), key).toBe(true);
    }
  });

  it('shares no key with a setting home, so no setting gets two editors', () => {
    const shared = moved.filter(key => HOME_BY_KEY.has(key));
    expect(shared).toEqual([]);
  });

  it.each([
    ['AI', aiTab],
    ['SecOps', findTab(settingsMap.freeTierModelGateEnabled.category)],
  ] as const)('renders no editor for a moved key in the %s sections', (_name, tab) => {
    renderTab(tab);

    for (const key of moved) {
      expect(screen.queryByTestId(`generic-setting-${key}`), key).toBeNull();
      expect(screen.queryByTestId(`string-list-setting-${key}`), key).toBeNull();
    }
    expect(screen.queryByTestId('admin-generation-models-card')).toBeNull();
  });

  it('still lists the other AI settings and links to Models > Settings', () => {
    renderAiTab();

    expect(screen.getByTestId('generic-setting-agentVideoClipsPerRun')).toBeTruthy();
    fireEvent.click(screen.getByTestId('admin-settings-models-link-AI'));
    const call = router.navigate.mock.calls.at(-1)?.[0] as { to: string; search: Record<string, unknown> };
    expect(call.to).toBe('/admin');
    expect(call.search).toMatchObject({ tab: 'models', modelsSection: 'settings' });
  });

  it('points to Models > Settings from every category that lost a key', () => {
    renderTab(findTab(settingsMap.freeTierModelGateEnabled.category));

    expect(
      screen.getByTestId(`admin-settings-models-link-${settingsMap.freeTierModelGateEnabled.category}`)
    ).toBeTruthy();
  });

  it('points a search for a moved key to Models > Settings', () => {
    router.search = { tab: 'admin-settings', q: 'free-tier model gate' };
    renderSettings();

    expect(screen.queryByTestId('generic-setting-freeTierModelGateEnabled')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-settings-search-models-link'));
    expect(router.navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/admin' }));
  });

  it('shows no Models pointer for an unrelated search', () => {
    router.search = { tab: 'admin-settings', q: 'slack' };
    renderSettings();

    expect(screen.queryByTestId('admin-settings-search-models-hint')).toBeNull();
  });
});

describe('AdminSettingsTab Turnstile notice', () => {
  it.each([
    ['true', 'true'],
    ['false', 'false'],
    [true, 'true'],
    [false, 'false'],
  ])('passes enabled for a saved turnstileEnabled of %j', (saved, expected) => {
    serverSettings = [{ settingName: 'turnstileEnabled', settingValue: saved }];
    renderTab(usersTab);
    expect(screen.getByTestId('admin-turnstile-notice').getAttribute('data-enabled')).toBe(expected);
  });
});

describe('AdminSettingsTab reviewer emails setting', () => {
  it('renders the string-list editor with the stored reviewers and no generic card', () => {
    serverSettings = [{ settingName: 'ImageModerationReviewerEmails', settingValue: '["reviewer@example.com"]' }];
    renderSecurityTab();

    const field = screen.getByTestId('string-list-setting-ImageModerationReviewerEmails');
    expect(field.getAttribute('data-stored-value')).toContain('reviewer@example.com');
    expect(screen.queryByTestId('generic-setting-ImageModerationReviewerEmails')).toBeNull();
  });

  it('gives the generic field to an object setting that defaults to an array', () => {
    // The editor belongs to the listed keys, not to every object setting that happens to hold a
    // list. No other rendered setting ships an array default, so lend one the shape here.
    const setting = settingsMap.customMcpBlockedHosts;
    const original = setting.defaultValue;
    (setting as { defaultValue: unknown }).defaultValue = [];
    try {
      renderTab(findTab(setting.category));

      expect(screen.getByTestId('generic-setting-customMcpBlockedHosts')).toBeTruthy();
      expect(screen.queryByTestId('string-list-setting-customMcpBlockedHosts')).toBeNull();
    } finally {
      (setting as { defaultValue: unknown }).defaultValue = original;
    }
  });
});

describe('AdminSettingsTab field default value', () => {
  const passedDefault = (key: SettingKey) =>
    JSON.parse(screen.getByTestId(`generic-setting-${key}`).getAttribute('data-default-value') ?? 'undefined');

  it('passes null for a clearDeletesRow setting with no stored row, not its declared default', () => {
    expect(settingsMap.forcedRetrievalMinSimilarityPct.clearDeletesRow).toBe(true);
    renderAiTab();

    expect(passedDefault('forcedRetrievalMinSimilarityPct')).toBeNull();
  });

  it.each([null, '', '  '])(
    'passes null for a clearDeletesRow setting whose stored row is blank (%j)',
    settingValue => {
      serverSettings = [{ settingName: 'forcedRetrievalMinSimilarityPct', settingValue }];
      renderAiTab();

      expect(passedDefault('forcedRetrievalMinSimilarityPct')).toBeNull();
    }
  );

  it('passes the stored value for a clearDeletesRow setting with a row', () => {
    serverSettings = [{ settingName: 'forcedRetrievalMinSimilarityPct', settingValue: 60 }];
    renderAiTab();

    expect(passedDefault('forcedRetrievalMinSimilarityPct')).toBe(60);
  });

  it('passes the declared default for a setting without the flag and no row', () => {
    expect(settingsMap.forcedRetrievalSpreadFloorPct.clearDeletesRow).toBeUndefined();
    renderAiTab();

    expect(passedDefault('forcedRetrievalSpreadFloorPct')).toBe(settingsMap.forcedRetrievalSpreadFloorPct.defaultValue);
  });
});

describe('AdminSettingsTab Credits System group', () => {
  const renderCreditsTab = () => renderTab(findTab(settingsMap.blockDisposableEmails.category));

  it('gives every home key exactly one home, the growth home holding the Growth and Pricing keys', () => {
    const seen = new Set<string>();
    for (const home of SETTING_HOMES) {
      for (const key of home.keys) {
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
        expect(settingsMap[key], key).toBeDefined();
      }
    }
    expect(HOME_BY_KEY.size).toBe(seen.size);
    const growth = SETTING_HOMES.find(home => home.id === 'growth-pricing');
    expect(growth?.keys).toEqual(GROWTH_PRICING_SECTIONS.flatMap(section => section.keys));
  });

  it('renders no generic editor for a home key in any section that holds one', () => {
    const tabs = new Set([...HOME_BY_KEY.keys()].map(key => findTab(settingsMap[key as SettingKey].category)));
    for (const tab of tabs) {
      if (!tab) continue;
      cleanup();
      renderTab(tab);
      for (const key of HOME_BY_KEY.keys()) {
        expect(screen.queryByTestId(`generic-setting-${key}`), `${tab.id}:${key}`).toBeNull();
      }
    }
  });

  it('keeps the rest of the Credits System group', () => {
    renderCreditsTab();

    for (const key of ['blockDisposableEmails', 'maxSignupsPerIpPerDay', 'syntheticUserEmailDomains']) {
      expect(screen.getByTestId(`generic-setting-${key}`), key).toBeTruthy();
    }
    // A pricing control: edited on Growth and Pricing.
    expect(screen.queryByTestId('generic-setting-billOperationalUsage')).toBeNull();
    expect(screen.getByTestId('string-list-setting-blockedEmailDomains')).toBeTruthy();
  });

  it('links to the Growth and Pricing tab', () => {
    useAdminModal.getState().setActiveTab(AdminTab.AdminSettings);
    renderCreditsTab();

    fireEvent.click(screen.getByTestId('admin-settings-credits-growth-pricing-link'));
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.GrowthPricing);
  });

  it.each([
    ['invite-center-schedule', 'schedule'],
    ['invite-center-rewards', 'rewards'],
  ])('links to the Invite Center home %s', (homeId, section) => {
    renderCreditsTab();

    fireEvent.click(screen.getByTestId(`admin-settings-credits-${homeId}-link`));
    expect(lastWrittenSearch({ tab: 'admin-settings', q: 'x' })).toMatchObject({
      tab: 'waitlist',
      inviteSection: section,
      q: undefined,
    });
  });

  it('points a search for a Growth and Pricing key to that tab', () => {
    useAdminModal.getState().setActiveTab(AdminTab.AdminSettings);
    router.search = { tab: 'admin-settings', q: 'price per credit' };
    renderSettings();

    expect(screen.queryByTestId('generic-setting-pricePerCredit')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-settings-search-growth-pricing-link'));
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.GrowthPricing);
  });

  it.each([
    // 'drip' matches the drip cap's name; the audit log links a setting change as ?q=<key>.
    ['drip', 'invite-center-schedule', 'schedule'],
    ['signupGrantDripCap', 'invite-center-schedule', 'schedule'],
    ['freeTierDays2To7SpendCapCredits', 'invite-center-schedule', 'schedule'],
    ['ReferralHoldDays', 'invite-center-rewards', 'rewards'],
    ['gearRewardMinAccountAgeDays', 'invite-center-rewards', 'rewards'],
  ])('points a search for %s to its Invite Center section', (q, homeId, section) => {
    router.search = { tab: 'admin-settings', q };
    renderSettings();

    expect(screen.getByTestId(`admin-settings-search-${homeId}-hint`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`admin-settings-search-${homeId}-link`));
    expect(lastWrittenSearch({ tab: 'admin-settings', q })).toMatchObject({ tab: 'waitlist', inviteSection: section });
  });

  it('shows no home pointer for an unrelated search', () => {
    router.search = { tab: 'admin-settings', q: 'slack' };
    renderSettings();

    for (const home of SETTING_HOMES) expect(screen.queryByTestId(`admin-settings-search-${home.id}-hint`)).toBeNull();
  });
});

describe('AdminSettingsTab stage-hidden settings', () => {
  const stageGated = ['signupGrantActivityPreviewTestMode'] as const;
  const renderUsersTab = () => renderTab(findTab(settingsMap.signupGrantActivityPreviewTestMode.category));

  it('hides the keys the server reports for this stage', () => {
    serverConfig = { hiddenAdminSettingKeys: [...stageGated] };
    renderUsersTab();

    for (const key of stageGated) expect(screen.queryByTestId(`generic-setting-${key}`), key).toBeNull();
    expect(screen.getByTestId('generic-setting-signupGrantActivityMinActiveSeconds')).toBeTruthy();
  });

  it('shows them when the server hides nothing', () => {
    renderUsersTab();

    for (const key of stageGated) expect(screen.getByTestId(`generic-setting-${key}`), key).toBeTruthy();
  });

  it.each([
    ['config still loading', undefined],
    ['config without the field', {}],
  ])('hides them while the stage is unknown (%s)', (_label, config) => {
    serverConfig = config;
    renderUsersTab();

    for (const key of stageGated) expect(screen.queryByTestId(`generic-setting-${key}`), key).toBeNull();
  });

  it('keeps them out of an All Tabs search', () => {
    serverConfig = { hiddenAdminSettingKeys: [...stageGated] };
    router.search = { tab: 'admin-settings', q: 'signup' };
    renderSettings();
    fireEvent.click(screen.getByRole('checkbox', { name: 'All Tabs' }));

    expect(screen.getByTestId('generic-setting-signupGrantActivityMinActiveSeconds')).toBeTruthy();
    for (const key of stageGated) expect(screen.queryByTestId(`generic-setting-${key}`), key).toBeNull();
  });
});

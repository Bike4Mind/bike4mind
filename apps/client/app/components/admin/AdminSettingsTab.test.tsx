import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SETTING_TABS, settingsMap, type SettingKey } from '@bike4mind/common';

// Read at render time, so a test can seed the stored platform rows.
let serverSettings: { settingName: string; settingValue: unknown }[] = [];
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: serverSettings, isLoading: false }),
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('./EmbeddingProviderLimits', () => ({ EmbeddingProviderLimits: () => null }));
vi.mock('./AdminOperationsModelSetting', () => ({ AdminOperationsModelSetting: () => null }));
vi.mock('./AdminTurnstileStatusNotice', () => ({
  AdminTurnstileStatusNotice: ({ enabled }: { enabled: boolean }) => (
    <div data-testid="admin-turnstile-notice" data-enabled={String(enabled)} />
  ),
}));
vi.mock('./ScopedOverridesByScope', () => ({ ScopedOverridesByScope: () => null }));
vi.mock('./AdminLogoUpload', () => ({ default: () => null }));
vi.mock('./AdminGenerationModelsSetting', () => ({
  AdminGenerationModelsSetting: () => <div data-testid="admin-generation-models-card" />,
}));
vi.mock('./AdminRecommendedModelsSetting', () => ({
  AdminRecommendedModelsSetting: () => <div data-testid="admin-recommended-models-card" />,
}));
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

import AdminSettingsTab, { GROWTH_PRICING_ONLY_KEYS } from './AdminSettingsTab';
import { GROWTH_PRICING_SECTIONS } from './AdminGrowthPricingTab';
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
  serverSettings = [];
  router.search = {};
  router.navigate.mockReset();
});

describe('AdminSettingsTab URL state', () => {
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

describe('AdminSettingsTab generation models setting', () => {
  it('renders the bespoke generation models card and no generic video or music card', () => {
    renderAiTab();

    expect(screen.getByTestId('admin-generation-models-card')).toBeTruthy();
    expect(screen.queryByTestId('generic-setting-videoGeneration')).toBeNull();
    expect(screen.queryByTestId('generic-setting-musicGeneration')).toBeNull();
  });
});

describe('AdminSettingsTab recommended models setting', () => {
  it('renders the bespoke recommended models editor and no generic recommendedModelIds card', () => {
    renderAiTab();

    expect(screen.getByTestId('admin-recommended-models-card')).toBeTruthy();
    expect(screen.queryByTestId('generic-setting-recommendedModelIds')).toBeNull();
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
  const renderCreditsTab = () => renderTab(findTab(settingsMap.billOperationalUsage.category));

  it('lists only keys the Growth and Pricing tab edits', () => {
    const growthPricingKeys = new Set<string>(GROWTH_PRICING_SECTIONS.flatMap(section => section.keys));
    for (const key of GROWTH_PRICING_ONLY_KEYS) expect(growthPricingKeys.has(key), key).toBe(true);
  });

  it('renders no editor for the Growth and Pricing keys and keeps the rest of the group', () => {
    renderCreditsTab();

    for (const key of GROWTH_PRICING_ONLY_KEYS) {
      expect(screen.queryByTestId(`generic-setting-${key}`), key).toBeNull();
    }
    for (const key of ['billOperationalUsage', 'blockDisposableEmails', 'syntheticUserEmailDomains']) {
      expect(screen.getByTestId(`generic-setting-${key}`), key).toBeTruthy();
    }
    expect(screen.getByTestId('string-list-setting-blockedEmailDomains')).toBeTruthy();
  });

  it('links to the Growth and Pricing tab', () => {
    useAdminModal.getState().setActiveTab(AdminTab.AdminSettings);
    renderCreditsTab();

    fireEvent.click(screen.getByTestId('admin-settings-credits-growth-pricing-link'));
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.GrowthPricing);
  });

  it('points a search for a Growth and Pricing key to that tab', () => {
    useAdminModal.getState().setActiveTab(AdminTab.AdminSettings);
    router.search = { tab: 'admin-settings', q: 'price per credit' };
    renderSettings();

    expect(screen.queryByTestId('generic-setting-pricePerCredit')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-settings-search-growth-pricing-link'));
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.GrowthPricing);
  });

  it('shows no Growth and Pricing pointer for an unrelated search', () => {
    router.search = { tab: 'admin-settings', q: 'slack' };
    renderSettings();

    expect(screen.queryByTestId('admin-settings-search-growth-pricing-hint')).toBeNull();
  });
});

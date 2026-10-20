import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

import AdminSettingsTab from './AdminSettingsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const findTab = (category: string) =>
  Object.values(SETTING_TABS).find(tab => (tab.categories as readonly string[]).includes(category));

const aiTab = findTab(settingsMap.videoGeneration.category);
const securityTab = findTab(settingsMap.ImageModerationReviewerEmails.category);

const renderTab = (tab: typeof aiTab) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminSettingsTab />
    </CssVarsProvider>
  );
  expect(tab).toBeDefined();
  fireEvent.click(screen.getAllByRole('tab', { name: new RegExp(tab!.name, 'i') })[0]);
};

const renderAiTab = () => renderTab(aiTab);
const renderSecurityTab = () => renderTab(securityTab);

beforeEach(() => {
  serverSettings = [];
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

describe('AdminSettingsTab reviewer emails setting', () => {
  it('renders the string-list editor with the stored reviewers and no generic card', () => {
    serverSettings = [{ settingName: 'ImageModerationReviewerEmails', settingValue: '["reviewer@example.com"]' }];
    renderSecurityTab();

    const field = screen.getByTestId('string-list-setting-ImageModerationReviewerEmails');
    expect(field.getAttribute('data-stored-value')).toContain('reviewer@example.com');
    expect(screen.queryByTestId('generic-setting-ImageModerationReviewerEmails')).toBeNull();
  });

  it('does not give the string-list editor to other object settings', () => {
    renderSecurityTab();

    expect(screen.queryByTestId('string-list-setting-recommendedModelIds')).toBeNull();
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

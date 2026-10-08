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
vi.mock('./AdminVideoModelsSetting', () => ({
  AdminVideoModelsSetting: () => <div data-testid="admin-video-models-card" />,
}));
vi.mock('./AdminSettingInputField', () => ({
  default: ({ setting, defaultValue }: { setting: { key: SettingKey }; defaultValue: unknown }) => (
    <div data-testid={`generic-setting-${setting.key}`} data-default-value={JSON.stringify(defaultValue)} />
  ),
}));

import AdminSettingsTab from './AdminSettingsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const aiTab = Object.values(SETTING_TABS).find(tab =>
  (tab.categories as readonly string[]).includes(settingsMap.videoGeneration.category)
);

const renderAiTab = () => {
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminSettingsTab />
    </CssVarsProvider>
  );
  expect(aiTab).toBeDefined();
  fireEvent.click(screen.getAllByRole('tab', { name: new RegExp(aiTab!.name, 'i') })[0]);
};

beforeEach(() => {
  serverSettings = [];
});

describe('AdminSettingsTab video generation setting', () => {
  it('renders the bespoke video models card and no generic videoGeneration card', () => {
    renderAiTab();

    expect(screen.getByTestId('admin-video-models-card')).toBeTruthy();
    expect(screen.queryByTestId('generic-setting-videoGeneration')).toBeNull();
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

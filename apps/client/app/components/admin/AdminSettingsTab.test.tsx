import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SETTING_TABS, settingsMap, type SettingKey } from '@bike4mind/common';

vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({ data: [], isLoading: false }),
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
  default: ({ setting }: { setting: { key: SettingKey } }) => <div data-testid={`generic-setting-${setting.key}`} />,
}));

import AdminSettingsTab from './AdminSettingsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const aiTabId = Object.entries(SETTING_TABS).find(([, tab]) =>
  (tab.categories as readonly string[]).includes(settingsMap.videoGeneration.category)
)?.[0];

describe('AdminSettingsTab video generation setting', () => {
  it('renders the bespoke video models card and no generic videoGeneration card', () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <AdminSettingsTab />
      </CssVarsProvider>
    );
    if (aiTabId) fireEvent.click(screen.getAllByRole('tab', { name: new RegExp(SETTING_TABS[aiTabId].label, 'i') })[0]);

    expect(screen.getByTestId('admin-video-models-card')).toBeTruthy();
    expect(screen.queryByTestId('generic-setting-videoGeneration')).toBeNull();
  });
});

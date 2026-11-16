import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SettingsSection } from './SettingsSection';
import { SettingFieldRow, settingFieldRowStyles } from './SettingFieldRow';

describe('SettingFieldRow', () => {
  it.each(['light', 'dark'] as const)('uses only a divider between transparent rows in %s mode', mode => {
    render(
      <CssVarsProvider theme={extendTheme({ ...getThemeConfig() })} defaultMode={mode}>
        <SettingsSection>
          <SettingFieldRow data-testid="setting-row-first">First</SettingFieldRow>
          <SettingFieldRow data-testid="setting-row-last">Last</SettingFieldRow>
        </SettingsSection>
      </CssVarsProvider>
    );
    const first = screen.getByTestId('setting-row-first');
    const last = screen.getByTestId('setting-row-last');
    for (const row of [first, last]) {
      expect(row).toHaveAttribute('data-admin-setting-row');
      expect(row).not.toHaveAttribute('variant');
    }
    expect(settingFieldRowStyles).not.toHaveProperty('bgcolor');
    expect(settingFieldRowStyles).not.toHaveProperty('border');
    expect(settingFieldRowStyles).not.toHaveProperty('borderRadius');
    expect(settingFieldRowStyles).not.toHaveProperty('mb');
    expect(settingFieldRowStyles['&:not(:last-child)']).toEqual({
      borderBottom: '1px solid',
      borderColor: 'admin.border',
    });
  });
});

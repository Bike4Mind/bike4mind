import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SENSITIVE_SETTING_MASK, settingsMap } from '@bike4mind/common';

const mutate = vi.fn();
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: false }),
}));

import AdminSettingInputField from './AdminSettingInputField';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// anthropicDemoKey is isSensitive, so the server only ever sends this field a mask.
const maskedValue = `${SENSITIVE_SETTING_MASK}tail`;

const renderSensitiveField = (defaultValue: string) =>
  render(
    <TestWrapper>
      <AdminSettingInputField setting={settingsMap.anthropicDemoKey} index={0} defaultValue={defaultValue} />
    </TestWrapper>
  );

const input = () => screen.getByTestId('admin-setting-anthropicDemoKey-input') as HTMLInputElement;

describe('AdminSettingInputField sensitive setting', () => {
  beforeEach(() => {
    mutate.mockReset();
  });

  it('shows the server mask and reveals nothing on focus', () => {
    renderSensitiveField(maskedValue);
    expect(input().value).toBe(maskedValue);

    fireEvent.focus(input());

    // The old behaviour swapped in the real value here. There is no real value to swap in
    // any more, and the mask must not survive into a submitted write either.
    expect(input().value).toBe('');
  });

  it('restores the mask when focus leaves without an edit', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(input().value).toBe(maskedValue);
  });

  it('submits a newly typed secret and then holds only what the server returns', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-fresh' } });
    fireEvent.click(screen.getByRole('button'));

    expect(mutate).toHaveBeenCalledWith(
      { key: 'anthropicDemoKey', value: 'sk-ant-api03-fresh' },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );

    // The mutation's onSuccess replaces the typed plaintext with the server's mask so the
    // secret does not linger in the DOM after the write.
    const { onSuccess } = mutate.mock.calls[0][1];
    act(() => onSuccess({ settingName: 'anthropicDemoKey', settingValue: `${SENSITIVE_SETTING_MASK}resh` }));
    expect(input().value).toBe(`${SENSITIVE_SETTING_MASK}resh`);
  });
});

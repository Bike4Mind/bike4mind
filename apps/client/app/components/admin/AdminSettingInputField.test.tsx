import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SENSITIVE_SETTING_MASK, settingsMap } from '@bike4mind/common';

const mutate = vi.fn();
// Read at render time, so a test can put the mutation into its rejected state.
let updateError: unknown;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: false, error: updateError }),
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
// Qualified by testid: an unqualified getByRole('button') breaks with a confusing
// "multiple elements" error the moment another button lands in this card.
const saveButton = () => screen.getByTestId('admin-setting-anthropicDemoKey-save-btn');

describe('AdminSettingInputField sensitive setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    updateError = undefined;
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

  it('keeps Save disabled while the field is empty only because focus cleared the mask', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());

    expect(input().value).toBe('');
    expect(saveButton()).toBeDisabled();
  });

  it('does not write when Save is clicked after focus without typing', () => {
    renderSensitiveField(maskedValue);

    // Blur would restore the mask and re-disable Save, but a click is not guaranteed to
    // blur the input first (macOS Safari and Firefox do not focus buttons on click), so
    // the write path is guarded independently of event ordering.
    fireEvent.focus(input());
    fireEvent.click(saveButton());

    expect(mutate).not.toHaveBeenCalled();
  });

  it('hides typed plaintext so a pasted key does not stay rendered after blur', () => {
    renderSensitiveField(maskedValue);
    // The server mask stays readable, so its last-4 tail is usable.
    expect(input().getAttribute('type')).toBe('text');

    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-fresh' } });

    // Once real plaintext is in the field it must not be readable over someone's shoulder,
    // which is the property main had via its re-mask-on-blur and this PR would otherwise drop.
    expect(input().getAttribute('type')).toBe('password');
  });

  it('still allows an admin to deliberately clear a stored secret', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    // Focus already emptied the field, so a real clear is type-then-delete. That is an
    // explicit edit, unlike the untouched-empty state above, and must still reach the server.
    fireEvent.change(input(), { target: { value: 'x' } });
    fireEvent.change(input(), { target: { value: '' } });

    expect(saveButton()).not.toBeDisabled();
    fireEvent.click(saveButton());
    expect(mutate).toHaveBeenCalledWith({ key: 'anthropicDemoKey', value: '', confirmClear: true }, expect.anything());
  });

  it('submits a newly typed secret and then holds only what the server returns', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-fresh' } });
    fireEvent.click(saveButton());

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

// modelDiscoveryPriceBandPct is the bounded case: makeNumberSetting gives its schema
// min 0 / max 500, and the update route parses with that schema.
const bandSetting = settingsMap.modelDiscoveryPriceBandPct;

const renderBandField = (defaultValue: number) =>
  render(
    <TestWrapper>
      <AdminSettingInputField setting={bandSetting} index={0} defaultValue={defaultValue} />
    </TestWrapper>
  );

const bandInput = () => screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-input') as HTMLInputElement;
const bandSaveButton = () => screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-save-btn');
const bandHelperText = () => screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-helper');

describe('AdminSettingInputField number setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    updateError = undefined;
  });

  it('carries the schema bounds the server enforces', () => {
    renderBandField(50);

    expect(bandInput()).toHaveAttribute('min', '0');
    expect(bandInput()).toHaveAttribute('max', '500');
  });

  it('explains an out-of-range value rather than letting the save do nothing', () => {
    renderBandField(50);
    fireEvent.change(bandInput(), { target: { value: '600' } });

    // The reported bug: the schema rejects 600 server-side, so a field that submitted it
    // would look like a no-op save with no reason given anywhere.
    expect(bandHelperText()).toHaveTextContent('Enter a number between 0 and 500.');
    expect(bandSaveButton()).toBeDisabled();

    fireEvent.click(bandSaveButton());
    expect(mutate).not.toHaveBeenCalled();
  });

  it('saves a value inside the range and keeps showing the description', () => {
    renderBandField(50);
    fireEvent.change(bandInput(), { target: { value: '200' } });

    expect(bandHelperText()).toHaveTextContent(bandSetting.description);
    fireEvent.click(bandSaveButton());

    expect(mutate).toHaveBeenCalledWith({ key: 'modelDiscoveryPriceBandPct', value: 200 }, expect.anything());
  });

  it('surfaces the server reason when a write is rejected anyway', () => {
    updateError = { isAxiosError: true, response: { status: 400, data: { message: 'Number must be <= 500' } } };

    renderBandField(50);

    expect(bandHelperText()).toHaveTextContent('Number must be <= 500');
  });
});

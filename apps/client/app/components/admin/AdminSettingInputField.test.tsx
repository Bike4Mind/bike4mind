import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { SENSITIVE_SETTING_MASK, settingsMap } from '@bike4mind/common';

const mutate = vi.fn();
const mutateAsync = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'admin-settings' } } },
    navigate: vi.fn(),
  }),
}));
// Read at render time, so a test can put the mutation into its rejected state.
let updateError: unknown;
// Read at render time, so a test can simulate the save round-trip still being in flight.
let updatePending = false;
// A factory mock replaces the whole module, so every hook the component tree imports from it has
// to be listed here - ScopedSettingOverrides (rendered for any setting declaring `scope`) reaches
// the three scoped-override hooks, and a missing one fails this file at import time.
// Stands in for the hook's server-provided defaultEmbeddingModel; undefined leaves the field silent.
let floorWarning: string | undefined;
vi.mock('@client/app/hooks/data/settings', () => ({
  useFloorAboveMeasuredWarning: (key: string) => (key === 'forcedRetrievalMinSimilarityPct' ? floorWarning : undefined),
  useUpdateSettings: () => ({ mutate, mutateAsync, isPending: updatePending, error: updateError }),
  useScopedSettingOverrides: () => ({ data: [] }),
  useSetScopedSettingOverride: () => ({ mutate: vi.fn(), isPending: false, error: undefined }),
  useClearScopedSettingOverride: () => ({ mutate: vi.fn(), isPending: false, error: undefined }),
}));

import AdminSettingInputField from './AdminSettingInputField';
import { SettingsDraftProvider } from './SettingsDraftProvider';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// anthropicDemoKey is isSensitive, so the server only ever sends this field a mask.
const maskedValue = `${SENSITIVE_SETTING_MASK}tail`;

const renderStaged = (field: React.ReactElement) =>
  render(
    <TestWrapper>
      <SettingsDraftProvider>{field}</SettingsDraftProvider>
    </TestWrapper>
  );
const saveBar = () => screen.queryByTestId('admin-save-bar');
const saveConfirm = () => screen.getByTestId('admin-save-confirm-btn');
const clickSave = async () => {
  await act(async () => {
    fireEvent.click(saveConfirm());
  });
};

const renderSensitiveField = (defaultValue: string) =>
  renderStaged(<AdminSettingInputField setting={settingsMap.anthropicDemoKey} index={0} defaultValue={defaultValue} />);

const input = () => screen.getByTestId('admin-setting-anthropicDemoKey-input') as HTMLInputElement;

describe('staged settings fields', () => {
  it('does not stage a focused mask and discards plaintext without a write', () => {
    render(
      <TestWrapper>
        <SettingsDraftProvider>
          <AdminSettingInputField setting={settingsMap.anthropicDemoKey} index={0} defaultValue={maskedValue} />
        </SettingsDraftProvider>
      </TestWrapper>
    );
    fireEvent.focus(input());
    expect(input()).toHaveValue('');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
    fireEvent.change(input(), { target: { value: 'synthetic-secret' } });
    expect(input()).toHaveAttribute('type', 'password');
    expect(screen.queryByTestId('admin-setting-anthropicDemoKey-save-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    fireEvent.blur(input());
    expect(input()).toHaveValue(maskedValue);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('saves through SaveBar on Ctrl+S from a staged input', async () => {
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ settingValue: 200 });
    render(
      <TestWrapper>
        <SettingsDraftProvider>
          <AdminSettingInputField setting={settingsMap.modelDiscoveryPriceBandPct} index={0} defaultValue={50} />
        </SettingsDraftProvider>
      </TestWrapper>
    );
    const field = screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-input');
    fireEvent.change(field, { target: { value: '200' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 's', ctrlKey: true });
    });
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'modelDiscoveryPriceBandPct', value: 200 });
  });
});

describe('AdminSettingInputField outside a SettingsDraftProvider', () => {
  it('throws, since the SaveBar is its only write path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <TestWrapper>
          <AdminSettingInputField setting={settingsMap.modelDiscoveryPriceBandPct} index={0} defaultValue={50} />
        </TestWrapper>
      )
    ).toThrow('AdminSettingInputField must be rendered inside a SettingsDraftProvider.');
    vi.mocked(console.error).mockRestore();
  });
});

describe('AdminSettingInputField inside a SettingsDraftProvider', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    updateError = undefined;
    updatePending = false;
  });

  it('renders no per-field Save for the field or an inline sub-setting, and stages both into the SaveBar', async () => {
    const sub = settingsMap.billOperationalUsage;
    renderStaged(
      <AdminSettingInputField
        setting={settingsMap.EnforceLakeAdmission}
        index={0}
        defaultValue={false}
        subSettings={[{ setting: sub, defaultValue: false }]}
      />
    );
    fireEvent.click(screen.getByTestId('admin-setting-EnforceLakeAdmission-switch'));
    const subEditor = screen.getByLabelText(`${sub.name} settings editor`);
    fireEvent.click(subEditor.querySelector('input[type="checkbox"]') as HTMLInputElement);

    expect(screen.queryByTestId('admin-setting-EnforceLakeAdmission-save-btn')).toBeNull();
    expect(screen.queryByTestId(`admin-setting-${sub.key}-save-btn`)).toBeNull();
    expect(saveBar()).toHaveTextContent('2 unsaved changes');

    await clickSave();
    expect(mutateAsync).toHaveBeenCalledWith({ key: 'EnforceLakeAdmission', value: true });
    expect(mutateAsync).toHaveBeenCalledWith({ key: sub.key, value: true });
    expect(mutate).not.toHaveBeenCalled();
  });
});

// pricePerCredit and teamPlanMinSeats are tagged changesCustomerPrice; modelDiscoveryPriceBandPct
// is not, and is the control for every "only the tagged ones" assertion below.
describe('AdminSettingInputField money-affecting setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({ settingValue: 60 });
    updateError = undefined;
    updatePending = false;
  });

  const renderPrice = (defaultValue: number = 50) =>
    renderStaged(<AdminSettingInputField setting={settingsMap.pricePerCredit} index={0} defaultValue={defaultValue} />);

  const priceInput = () => screen.getByTestId('admin-setting-pricePerCredit-input');

  it('badges the field so an admin can see it moves a customer bill', () => {
    renderPrice();
    expect(screen.getByTestId('admin-setting-pricePerCredit-money-badge')).toHaveTextContent('Changes customer price');
  });

  it('leaves a setting that does not change a bill unbadged', () => {
    renderStaged(
      <AdminSettingInputField setting={settingsMap.modelDiscoveryPriceBandPct} index={0} defaultValue={50} />
    );
    expect(screen.queryByTestId('admin-setting-modelDiscoveryPriceBandPct-money-badge')).toBeNull();
  });

  it('writes nothing when the admin backs out of the warning, and keeps the edit', async () => {
    renderPrice();
    fireEvent.change(priceInput(), { target: { value: '60' } });
    await clickSave();
    fireEvent.click(screen.getByTestId('admin-settings-warning-cancel-btn'));
    expect(mutateAsync).not.toHaveBeenCalled();
    // The edit survives the cancel, so backing out of the confirm is not also a discard.
    expect(priceInput()).toHaveValue(60);
    expect(saveBar()).toHaveTextContent('1 unsaved change');
  });

  // The one path that could quietly bypass the warning.
  it('routes Cmd/Ctrl+S through the same warning', async () => {
    renderPrice();
    fireEvent.change(priceInput(), { target: { value: '60' } });
    await act(async () => {
      fireEvent.keyDown(priceInput(), { key: 's', ctrlKey: true });
    });
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByTestId('admin-settings-warning-dialog')).toBeInTheDocument();
  });

  it('renders a boolean price setting as on and off rather than true and false', async () => {
    renderStaged(<AdminSettingInputField setting={settingsMap.billOperationalUsage} index={0} defaultValue={false} />);
    fireEvent.click(screen.getByTestId('admin-setting-billOperationalUsage-switch'));
    await clickSave();
    expect(screen.getByTestId('admin-settings-warning-dialog')).toHaveTextContent(
      'Bill Operational Usage changes what customers pay: off to on.'
    );
  });

  // The SaveBar commits every edit, so the batched warning is the only thing standing in front of
  // a price change on Admin Settings and Growth and Pricing.
  it('warns through the SaveBar before writing', async () => {
    renderPrice();
    fireEvent.change(priceInput(), { target: { value: '60' } });
    await clickSave();
    expect(mutateAsync).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('admin-settings-warning-dialog');
    expect(dialog).toHaveTextContent(
      'Price Per Credit changes what customers pay: 50 ($50 per credit) to 60 ($60 per credit).'
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('admin-settings-warning-save-btn'));
    });
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'pricePerCredit', value: 60 });
  });

  it('quotes the value being saved, not the one before the last keystroke', async () => {
    renderPrice();
    fireEvent.change(priceInput(), { target: { value: '60' } });
    fireEvent.change(priceInput(), { target: { value: '70' } });
    await clickSave();
    expect(screen.getByTestId('admin-settings-warning-dialog')).toHaveTextContent(
      'Price Per Credit changes what customers pay: 50 ($50 per credit) to 70 ($70 per credit).'
    );
  });

  it('does not stand in front of a setting that changes no bill', async () => {
    renderStaged(
      <AdminSettingInputField setting={settingsMap.modelDiscoveryPriceBandPct} index={0} defaultValue={50} />
    );
    fireEvent.change(screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-input'), {
      target: { value: '60' },
    });
    await clickSave();
    expect(screen.queryByTestId('admin-settings-warning-dialog')).toBeNull();
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'modelDiscoveryPriceBandPct', value: 60 });
  });
});

describe('AdminSettingInputField sensitive setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    updateError = undefined;
    updatePending = false;
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

  it('stages nothing while the field is empty only because focus cleared the mask', () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());

    expect(input().value).toBe('');
    expect(saveBar()).toBeNull();
  });

  it('does not write on Cmd/Ctrl+S after focus without typing', async () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    await act(async () => {
      fireEvent.keyDown(input(), { key: 's', ctrlKey: true });
    });

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('hides typed plaintext so a pasted key does not stay rendered after blur', () => {
    renderSensitiveField(maskedValue);
    // The server mask stays readable, so its last-4 tail is usable.
    expect(input().getAttribute('type')).toBe('text');

    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-fresh' } });

    // Once real plaintext is in the field it must not be readable over someone's shoulder.
    expect(input().getAttribute('type')).toBe('password');
  });

  it('still allows an admin to deliberately clear a stored secret', async () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    // Focus already emptied the field, so a real clear is type-then-delete. That is an
    // explicit edit, unlike the untouched-empty state above, and must still reach the server.
    fireEvent.change(input(), { target: { value: 'x' } });
    fireEvent.change(input(), { target: { value: '' } });

    expect(saveConfirm()).toBeEnabled();
    await clickSave();
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'anthropicDemoKey', value: '', confirmClear: true });
  });

  it('submits a newly typed secret and drops the plaintext once it is saved', async () => {
    renderSensitiveField(maskedValue);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-fresh' } });
    fireEvent.blur(input());
    await clickSave();

    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'anthropicDemoKey', value: 'sk-ant-api03-fresh' });
    expect(input().value).toBe(maskedValue);
    expect(saveBar()).toBeNull();
  });
});

// modelDiscoveryPriceBandPct is the bounded case: makeNumberSetting gives its schema
// min 0 / max 500, and the update route parses with that schema.
const bandSetting = settingsMap.modelDiscoveryPriceBandPct;

const renderBandField = (defaultValue: number) =>
  renderStaged(<AdminSettingInputField setting={bandSetting} index={0} defaultValue={defaultValue} />);

const bandInput = () => screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-input') as HTMLInputElement;
const bandHelperText = () => screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-helper');

describe('AdminSettingInputField number setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    updateError = undefined;
    updatePending = false;
  });

  it('carries the schema bounds the server enforces', () => {
    renderBandField(50);

    expect(bandInput()).toHaveAttribute('min', '0');
    expect(bandInput()).toHaveAttribute('max', '500');
  });

  it('explains an out-of-range value rather than letting the save do nothing', async () => {
    renderBandField(50);
    fireEvent.change(bandInput(), { target: { value: '600' } });

    // The schema rejects 600 server-side, so a field that submitted it would look like a
    // no-op save with no reason given anywhere.
    expect(bandHelperText()).toHaveTextContent('Enter a number between 0 and 500.');
    expect(saveBar()).toHaveTextContent('Enter a number between 0 and 500.');
    expect(saveConfirm()).toBeDisabled();

    await clickSave();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('saves a value inside the range and keeps showing the description', async () => {
    renderBandField(50);
    fireEvent.change(bandInput(), { target: { value: '200' } });

    expect(bandHelperText()).toHaveTextContent(bandSetting.description);
    await clickSave();

    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'modelDiscoveryPriceBandPct', value: 200 });
  });

  it('forwards a cleared field as an empty value instead of coercing it to 0', async () => {
    renderBandField(50);
    fireEvent.change(bandInput(), { target: { value: '' } });

    // Number('') is 0, which this setting's min 0 accepts as a genuine zero - so a field that
    // coerced here would store a real 0 and step past makeNumberSetting's empty-string
    // preprocess, the one thing that restores the setting's own default.
    expect(bandInput().value).toBe('');
    expect(bandHelperText()).toHaveTextContent(bandSetting.description);
    expect(saveConfirm()).toBeEnabled();

    await clickSave();
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'modelDiscoveryPriceBandPct', value: '' });
  });

  it('surfaces the server reason when a write is rejected anyway', () => {
    updateError = { isAxiosError: true, response: { status: 400, data: { message: 'Number must be <= 500' } } };

    renderBandField(50);

    expect(bandHelperText()).toHaveTextContent('Number must be <= 500');
  });

  it('locks the field while a save is in flight', () => {
    updatePending = true;
    renderBandField(50);

    // The refetched setting resets this field to the server's value, so a second edit typed
    // mid-flight would otherwise be silently overwritten.
    expect(bandInput()).toBeDisabled();
  });
});

// MaxFileSize is the min-1 case: unlike modelDiscoveryPriceBandPct's min 0, Number('') is 0,
// which a min-0 setting accepts as genuine - so only a min >= 1 setting can exercise the guard
// that keeps an emptied field from being read as a below-minimum zero.
const sizeSetting = settingsMap.MaxFileSize;

const renderSizeField = (defaultValue: number) =>
  renderStaged(<AdminSettingInputField setting={sizeSetting} index={0} defaultValue={defaultValue} />);

const sizeInput = () => screen.getByTestId('admin-setting-MaxFileSize-input') as HTMLInputElement;
const sizeHelperText = () => screen.getByTestId('admin-setting-MaxFileSize-helper');

describe('AdminSettingInputField min-1 number setting', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    updateError = undefined;
    updatePending = false;
  });

  it('has a floor of at least 1, or the empty-field case below proves nothing', () => {
    expect(sizeSetting.type).toBe('number');
    if (sizeSetting.type === 'number') expect(sizeSetting.min).toBeGreaterThanOrEqual(1);
  });

  it('clearing the field reports no range error and leaves Save enabled', async () => {
    renderSizeField(30);
    fireEvent.change(sizeInput(), { target: { value: '' } });

    expect(sizeInput().value).toBe('');
    expect(sizeHelperText()).toHaveTextContent(sizeSetting.description);
    expect(saveConfirm()).toBeEnabled();

    await clickSave();
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'MaxFileSize', value: '' });
  });

  it('an explicit 0 still reports the below-minimum error and disables Save', async () => {
    renderSizeField(30);
    fireEvent.change(sizeInput(), { target: { value: '0' } });

    expect(sizeHelperText()).toHaveTextContent('Enter a number of 1 or more.');
    expect(saveConfirm()).toBeDisabled();

    await clickSave();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('saves a valid value inside the range', async () => {
    renderSizeField(30);
    fireEvent.change(sizeInput(), { target: { value: '100' } });

    expect(sizeHelperText()).toHaveTextContent(sizeSetting.description);
    await clickSave();

    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: 'MaxFileSize', value: 100 });
  });
});

describe('AdminSettingInputField clearDeletesRow number setting', () => {
  const floorSetting = settingsMap.forcedRetrievalMinSimilarityPct;
  const renderField = (setting: (typeof settingsMap)[keyof typeof settingsMap], defaultValue: number | null) =>
    renderStaged(<AdminSettingInputField setting={setting} index={0} defaultValue={defaultValue} />);
  const floorInput = () => screen.getByTestId(`admin-setting-${floorSetting.key}-input`) as HTMLInputElement;

  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
    updateError = undefined;
    updatePending = false;
  });

  it('renders an unset floor blank with its unset label, nothing staged', () => {
    expect(floorSetting.clearDeletesRow).toBe(true);
    renderField(floorSetting, null);

    expect(floorInput().value).toBe('');
    expect(floorInput()).toHaveAttribute('placeholder', 'per embedding space');
    expect(saveBar()).toBeNull();
  });

  it('saves a 75 typed into an unset floor as 75', async () => {
    renderField(floorSetting, null);
    fireEvent.change(floorInput(), { target: { value: '75' } });

    await clickSave();
    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: floorSetting.key, value: 75 });
  });

  it('does not offer a save after typing into an unset floor and deleting it again', () => {
    renderField(floorSetting, null);
    fireEvent.change(floorInput(), { target: { value: '7' } });
    fireEvent.change(floorInput(), { target: { value: '' } });

    expect(saveBar()).toBeNull();
  });

  it('clears a stored floor by sending an empty value', async () => {
    renderField(floorSetting, 60);
    fireEvent.change(floorInput(), { target: { value: '' } });
    await clickSave();

    expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({ key: floorSetting.key, value: '' });
    expect(saveBar()).toBeNull();
  });

  it('shows the above-measured warning and confirms it on save', async () => {
    floorWarning = '75% is above the 58% minimum measured for text-embedding-3-small';
    try {
      renderField(floorSetting, null);
      fireEvent.change(floorInput(), { target: { value: '75' } });

      expect(screen.getByTestId(`admin-setting-${floorSetting.key}-helper`)).toHaveTextContent(floorWarning);
      await clickSave();
      expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({
        key: floorSetting.key,
        value: 75,
        confirmAboveMeasuredFloor: true,
      });
    } finally {
      floorWarning = undefined;
    }
  });

  it('shows the above-measured warning even when an earlier save left an error on the field', () => {
    // The save sends the confirm flag whenever the warning is truthy, so the warning must win the
    // helper line over a stale error from a previous attempt - otherwise the flag is sent for a
    // warning the admin never saw.
    updateError = new Error('save failed earlier');
    floorWarning = '75% is above the 58% minimum measured for text-embedding-3-small';
    try {
      renderField(floorSetting, null);
      fireEvent.change(floorInput(), { target: { value: '75' } });

      expect(screen.getByTestId(`admin-setting-${floorSetting.key}-helper`)).toHaveTextContent(floorWarning);
    } finally {
      floorWarning = undefined;
      updateError = undefined;
    }
  });

  it('gives a number setting without the flag no unset placeholder', () => {
    expect(settingsMap.modelDiscoveryPriceBandPct.clearDeletesRow).toBeUndefined();
    renderField(settingsMap.modelDiscoveryPriceBandPct, 50);

    expect(screen.getByTestId('admin-setting-modelDiscoveryPriceBandPct-input')).not.toHaveAttribute('placeholder');
  });
});

describe('AdminSettingInputField locked setting', () => {
  it('disables a locked number setting, offers no Save, and shows why', () => {
    renderStaged(
      <AdminSettingInputField
        setting={bandSetting}
        index={0}
        defaultValue={50}
        lockedNote="Only full administrators can change this setting."
      />
    );

    expect(bandInput()).toBeDisabled();
    expect(screen.queryByTestId('admin-setting-modelDiscoveryPriceBandPct-save-btn')).toBeNull();
    expect(saveBar()).toBeNull();
    expect(bandHelperText()).toHaveTextContent('Only full administrators can change this setting.');
  });
});

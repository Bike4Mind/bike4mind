import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { settingsMap } from '@bike4mind/common';

const mutate = vi.fn();
const mutateAsync = vi.fn();
let updateError: unknown;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, mutateAsync, isPending: false, error: updateError }),
}));
vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'admin-settings' } } },
    navigate: vi.fn(),
  }),
}));

import AdminSchemaSettingField from './AdminSchemaSettingField';
import { SettingsDraftProvider } from './SettingsDraftProvider';
import { STRUCTURED_SETTINGS } from './schemaSettingForm';

const appTheme = extendTheme({ ...getThemeConfig() });
type Key = 'abuseAssessmentConfig' | 'autoContainmentConfig' | 'usagePatternSignalsConfig';

const renderField = (key: Key, storedValue: unknown = settingsMap[key].defaultValue, staged = false) => {
  const field = (
    <AdminSchemaSettingField
      setting={settingsMap[key]}
      structured={STRUCTURED_SETTINGS[key]}
      storedValue={storedValue}
      index={0}
    />
  );
  return render(
    <CssVarsProvider theme={appTheme}>
      {staged ? <SettingsDraftProvider>{field}</SettingsDraftProvider> : field}
    </CssVarsProvider>
  );
};

const byId = (id: string) => screen.getByTestId(id);
const pick = (selectTestId: string, option: string) => {
  fireEvent.click(byId(selectTestId));
  fireEvent.click(screen.getByRole('option', { name: option }));
};
const type = (testId: string, value: string) => fireEvent.change(byId(testId), { target: { value } });

describe('AdminSchemaSettingField', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    updateError = undefined;
  });

  it('renders a select for an enum, with None for a nullable one', () => {
    renderField('abuseAssessmentConfig');
    const model = byId('admin-setting-abuseAssessmentConfig-model-input');
    expect(model).toHaveTextContent('None');
    fireEvent.click(model);
    const options = screen.getAllByRole('option').map(option => option.textContent);
    expect(options).toEqual(['None', 'test-decisions', 'gpt-6-luna', 'jev-1.13.0', 'jev-latest']);
    expect(byId('admin-setting-abuseAssessmentConfig-model-field')).toHaveTextContent('Model');
  });

  it('renders mode as off/shadow/enforce without a None option', () => {
    renderField('autoContainmentConfig');
    fireEvent.click(byId('admin-setting-autoContainmentConfig-mode-input'));
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['off', 'shadow', 'enforce']);
  });

  it('renders a number input with its range, default and help text', () => {
    renderField('abuseAssessmentConfig');
    const input = byId('admin-setting-abuseAssessmentConfig-maxConcurrency-input') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('2');
    expect(input.min).toBe('1');
    expect(input.max).toBe('10');
    expect(byId('admin-setting-abuseAssessmentConfig-maxConcurrency-hint')).toHaveTextContent(
      'Default 2. Whole number from 1 to 10.'
    );
    expect(byId('admin-setting-abuseAssessmentConfig-maxConcurrency-helper')).toHaveTextContent(
      'Provider calls in flight at once'
    );
  });

  it('renders a switch for a boolean', () => {
    renderField('abuseAssessmentConfig');
    const sweep = byId('admin-setting-abuseAssessmentConfig-sweepEnabled-input') as HTMLInputElement;
    expect(sweep.type).toBe('checkbox');
    expect(sweep.checked).toBe(false);
    fireEvent.click(sweep);
    expect(sweep.checked).toBe(true);
  });

  it('groups a nested object in a fieldset and edits it by path', () => {
    renderField('usagePatternSignalsConfig');
    const group = byId('admin-setting-usagePatternSignalsConfig-weights-group');
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).getByText('Signal weights')).toBeInTheDocument();

    type('admin-setting-usagePatternSignalsConfig-weights.creditPolling-input', '40');
    fireEvent.click(byId('admin-setting-usagePatternSignalsConfig-save-btn'));
    expect(mutate.mock.calls[0][0].value.weights).toEqual({
      apiOnlyUsage: 25,
      regularCadence: 25,
      creditPolling: 40,
      quickApiKey: 25,
    });
  });

  it('resets a changed field to its default', () => {
    renderField('abuseAssessmentConfig', { ...settingsMap.abuseAssessmentConfig.defaultValue, maxCallsPerDay: 7 });
    const input = byId('admin-setting-abuseAssessmentConfig-maxCallsPerDay-input') as HTMLInputElement;
    expect(input.value).toBe('7');
    fireEvent.click(byId('admin-setting-abuseAssessmentConfig-maxCallsPerDay-reset-btn'));
    expect(input.value).toBe('100');
    expect(screen.queryByTestId('admin-setting-abuseAssessmentConfig-maxCallsPerDay-reset-btn')).toBeNull();
  });

  it('validates with the schema and blocks the save until fixed', () => {
    renderField('usagePatternSignalsConfig');
    const save = byId('admin-setting-usagePatternSignalsConfig-save-btn');

    type('admin-setting-usagePatternSignalsConfig-activeWindowHours-input', '9999');
    expect(byId('admin-setting-usagePatternSignalsConfig-activeWindowHours-helper')).toHaveTextContent(
      'Enter a whole number from 1 to 720.'
    );
    expect(save).toBeDisabled();

    type('admin-setting-usagePatternSignalsConfig-activeWindowHours-input', '1.5');
    expect(byId('admin-setting-usagePatternSignalsConfig-activeWindowHours-helper')).toHaveTextContent(
      'Enter a whole number from 1 to 720.'
    );

    type('admin-setting-usagePatternSignalsConfig-activeWindowHours-input', '');
    expect(save).toBeDisabled();

    type('admin-setting-usagePatternSignalsConfig-activeWindowHours-input', '12');
    expect(byId('admin-setting-usagePatternSignalsConfig-activeWindowHours-helper')).not.toHaveTextContent('Enter a');
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    expect(mutate).toHaveBeenCalledWith(
      { key: 'usagePatternSignalsConfig', value: expect.objectContaining({ activeWindowHours: 12 }) },
      expect.anything()
    );
  });

  it('confirms enforce mode before saving', () => {
    renderField('autoContainmentConfig');
    pick('admin-setting-autoContainmentConfig-mode-input', 'enforce');
    expect(byId('admin-setting-autoContainmentConfig-risk-alert')).toHaveTextContent('contains real accounts');

    fireEvent.click(byId('admin-setting-autoContainmentConfig-save-btn'));
    expect(mutate).not.toHaveBeenCalled();
    expect(byId('admin-setting-autoContainmentConfig-confirm-dialog')).toHaveTextContent('suspended');

    fireEvent.click(byId('admin-setting-autoContainmentConfig-confirm-cancel-btn'));
    expect(mutate).not.toHaveBeenCalled();

    fireEvent.click(byId('admin-setting-autoContainmentConfig-save-btn'));
    fireEvent.click(byId('admin-setting-autoContainmentConfig-confirm-save-btn'));
    expect(mutate).toHaveBeenCalledWith(
      { key: 'autoContainmentConfig', value: expect.objectContaining({ mode: 'enforce' }) },
      expect.anything()
    );
  });

  it('confirms turning on email domain blocking', () => {
    renderField('autoContainmentConfig');
    fireEvent.click(byId('admin-setting-autoContainmentConfig-blockEmailDomains-input'));
    expect(byId('admin-setting-autoContainmentConfig-risk-alert')).toHaveTextContent('blocks the whole domain');
    fireEvent.click(byId('admin-setting-autoContainmentConfig-save-btn'));
    expect(byId('admin-setting-autoContainmentConfig-confirm-dialog')).toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it('saves other edits without a confirm while enforce is already stored', () => {
    renderField('autoContainmentConfig', { ...settingsMap.autoContainmentConfig.defaultValue, mode: 'enforce' });
    expect(screen.queryByTestId('admin-setting-autoContainmentConfig-risk-alert')).toBeNull();
    type('admin-setting-autoContainmentConfig-maxPerHour-input', '3');
    fireEvent.click(byId('admin-setting-autoContainmentConfig-save-btn'));
    expect(mutate).toHaveBeenCalled();
  });

  it('routes the enforce warning through the SaveBar confirm when staged', () => {
    renderField('autoContainmentConfig', undefined, true);
    pick('admin-setting-autoContainmentConfig-mode-input', 'enforce');
    expect(screen.queryByTestId('admin-setting-autoContainmentConfig-save-btn')).toBeNull();

    fireEvent.click(byId('admin-setting-autoContainmentConfig-blockEmailDomains-input'));

    fireEvent.click(byId('admin-save-confirm-btn'));
    const dialog = byId('admin-settings-warning-dialog');
    expect(within(dialog).getByText(/contains real accounts/)).toBeInTheDocument();
    expect(within(dialog).getByText(/blocks the whole domain/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();

    fireEvent.click(byId('admin-settings-warning-save-btn'));
    expect(mutateAsync).toHaveBeenCalledWith({
      key: 'autoContainmentConfig',
      value: expect.objectContaining({ mode: 'enforce', blockEmailDomains: true }),
    });
  });

  it('blocks the staged SaveBar while a field is invalid', () => {
    renderField('abuseAssessmentConfig', undefined, true);
    type('admin-setting-abuseAssessmentConfig-dailyBudgetUsd-input', '5000');
    expect(byId('admin-save-bar')).toHaveTextContent('Fix the highlighted fields before saving.');
  });

  it('edits the value as JSON and applies it to the form', () => {
    renderField('abuseAssessmentConfig');
    fireEvent.click(byId('admin-setting-abuseAssessmentConfig-view-json-btn'));
    const json = byId('admin-setting-abuseAssessmentConfig-json-input') as HTMLTextAreaElement;
    expect(JSON.parse(json.value)).toEqual(settingsMap.abuseAssessmentConfig.defaultValue);

    fireEvent.change(json, { target: { value: '{ not json' } });
    fireEvent.click(byId('admin-setting-abuseAssessmentConfig-json-apply-btn'));
    expect(byId('admin-setting-abuseAssessmentConfig-json-helper')).toHaveTextContent('Enter valid JSON');

    fireEvent.change(json, {
      target: { value: JSON.stringify({ ...settingsMap.abuseAssessmentConfig.defaultValue, maxConcurrency: 4 }) },
    });
    fireEvent.click(byId('admin-setting-abuseAssessmentConfig-json-apply-btn'));
    expect(screen.queryByTestId('admin-setting-abuseAssessmentConfig-json-dialog')).toBeNull();
    expect((byId('admin-setting-abuseAssessmentConfig-maxConcurrency-input') as HTMLInputElement).value).toBe('4');
  });

  it('reads a stored JSON string and shows a save error', () => {
    updateError = new Error('Server refused the value');
    renderField('abuseAssessmentConfig', JSON.stringify({ dailyBudgetUsd: 3 }));
    expect((byId('admin-setting-abuseAssessmentConfig-dailyBudgetUsd-input') as HTMLInputElement).value).toBe('3');
    expect(byId('admin-setting-abuseAssessmentConfig-error')).toHaveTextContent('Server refused the value');
  });
});

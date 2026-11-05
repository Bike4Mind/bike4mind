import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

import AdminJsonSettingField, { toJsonText } from './AdminJsonSettingField';

const appTheme = extendTheme({ ...getThemeConfig() });
const setting = settingsMap.abuseAssessmentConfig;
const renderField = (storedValue: unknown) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminJsonSettingField setting={setting} storedValue={storedValue} index={0} />
    </CssVarsProvider>
  );

const input = () => screen.getByTestId('admin-setting-abuseAssessmentConfig-input') as HTMLTextAreaElement;
const saveButton = () => screen.getByTestId('admin-setting-abuseAssessmentConfig-save-btn');
const helper = () => screen.getByTestId('admin-setting-abuseAssessmentConfig-helper');

describe('AdminJsonSettingField', () => {
  beforeEach(() => {
    mutate.mockReset();
    mutateAsync.mockReset();
    updateError = undefined;
  });

  it('shows the stored object as JSON, from an object or its JSON string', () => {
    renderField('{"model":null,"dailyBudgetUsd":0}');
    expect(JSON.parse(input().value)).toEqual({ model: null, dailyBudgetUsd: 0 });
    expect(toJsonText('not json')).toBe('{}');
  });

  it('saves the edited object', () => {
    renderField({ dailyBudgetUsd: 0 });
    expect(saveButton()).toBeDisabled();

    fireEvent.change(input(), { target: { value: '{ "dailyBudgetUsd": 5 }' } });
    fireEvent.click(saveButton());

    expect(mutate).toHaveBeenCalledWith(
      { key: 'abuseAssessmentConfig', value: { dailyBudgetUsd: 5 } },
      expect.anything()
    );
  });

  it('refuses invalid JSON without calling the server', () => {
    renderField({ dailyBudgetUsd: 0 });
    fireEvent.change(input(), { target: { value: '{ "dailyBudgetUsd": ' } });

    expect(saveButton()).toBeDisabled();
    expect(helper().textContent).toContain('valid JSON');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('shows the server refusal', () => {
    updateError = new Error('dailyBudgetUsd: Too big');
    renderField({ dailyBudgetUsd: 0 });
    expect(helper().textContent).toContain('Too big');
  });
});

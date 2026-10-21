import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { settingsMap } from '@bike4mind/common';

const mutate = vi.fn();
let updateError: unknown;
vi.mock('@client/app/hooks/data/settings', () => ({
  useUpdateSettings: () => ({ mutate, isPending: false, error: updateError }),
}));

import AdminStringListSettingField, { toStringList } from './AdminStringListSettingField';

const appTheme = extendTheme({ ...getThemeConfig() });
const setting = settingsMap.ImageModerationReviewerEmails;
const renderField = (storedValue: unknown) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <AdminStringListSettingField setting={setting} storedValue={storedValue} index={0} />
    </CssVarsProvider>
  );

const input = () => screen.getByTestId('admin-setting-ImageModerationReviewerEmails-input') as HTMLTextAreaElement;
const saveButton = () => screen.getByTestId('admin-setting-ImageModerationReviewerEmails-save-btn');

describe('AdminStringListSettingField', () => {
  beforeEach(() => {
    mutate.mockReset();
    updateError = undefined;
  });

  it('shows the stored list one entry per line, from an array or its JSON string', () => {
    renderField('["a@example.com","b@example.com"]');
    expect(input().value).toBe('a@example.com\nb@example.com');
    expect(toStringList(['x@example.com', 3])).toEqual(['x@example.com']);
  });

  it('saves the edited entries as a string array', () => {
    renderField([]);
    expect(saveButton()).toBeDisabled();

    fireEvent.change(input(), { target: { value: ' reviewer@example.com \n\nsecond@example.com' } });
    fireEvent.click(saveButton());

    expect(mutate).toHaveBeenCalledWith(
      { key: 'ImageModerationReviewerEmails', value: ['reviewer@example.com', 'second@example.com'] },
      expect.anything()
    );
  });

  it('shows the server refusal for an invalid address', () => {
    updateError = new Error('Not a valid email address: "nope"');
    renderField([]);
    expect(screen.getByTestId('admin-setting-ImageModerationReviewerEmails-helper').textContent).toContain('nope');
  });
});

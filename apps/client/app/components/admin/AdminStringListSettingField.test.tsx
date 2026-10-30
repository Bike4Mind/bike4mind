import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import AdminStringListSettingField, { toStringList } from './AdminStringListSettingField';
import { SettingsDraftProvider } from './SettingsDraftProvider';

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
    mutateAsync.mockReset();
    mutateAsync.mockResolvedValue({});
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

  it('saves the edited entries on Cmd/Ctrl+S from the focused card', () => {
    renderField([]);
    fireEvent.change(input(), { target: { value: 'reviewer@example.com' } });
    fireEvent.keyDown(screen.getByLabelText(`${setting.name} settings editor`), { key: 's', metaKey: true });

    expect(mutate).toHaveBeenCalledWith(
      { key: 'ImageModerationReviewerEmails', value: ['reviewer@example.com'] },
      expect.anything()
    );
  });

  it('shows the server refusal for an invalid address', () => {
    updateError = new Error('Not a valid email address: "nope"');
    renderField([]);
    expect(screen.getByTestId('admin-setting-ImageModerationReviewerEmails-helper').textContent).toContain('nope');
  });

  it('keeps formatting editable without staging unchanged lists and saves added entries', async () => {
    render(
      <CssVarsProvider theme={appTheme}>
        <SettingsDraftProvider>
          <AdminStringListSettingField setting={setting} storedValue={['a@example.com']} index={0} />
        </SettingsDraftProvider>
      </CssVarsProvider>
    );

    for (const value of ['a@example.com\n', ' a@example.com ', 'a@example.com,\n']) {
      fireEvent.change(input(), { target: { value } });
      expect(input()).toHaveValue(value);
      expect(screen.queryByTestId('admin-save-bar')).toBeNull();
      fireEvent.keyDown(window, { key: 's', metaKey: true });
      expect(mutateAsync).not.toHaveBeenCalled();
    }

    fireEvent.change(input(), { target: { value: 'a@example.com\nb@example.com' } });
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    fireEvent.change(input(), { target: { value: 'a@example.com\n' } });
    expect(input()).toHaveValue('a@example.com\n');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();

    fireEvent.change(input(), { target: { value: 'a@example.com\nb@example.com' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledExactlyOnceWith({
        key: setting.key,
        value: ['a@example.com', 'b@example.com'],
      })
    );
  });

  it('refreshes a clean formatted list when the stored value changes', () => {
    const field = (storedValue: string[]) => (
      <CssVarsProvider theme={appTheme}>
        <SettingsDraftProvider>
          <AdminStringListSettingField setting={setting} storedValue={storedValue} index={0} />
        </SettingsDraftProvider>
      </CssVarsProvider>
    );
    const { rerender } = render(field(['a@example.com']));
    fireEvent.change(input(), { target: { value: 'a@example.com\n' } });
    expect(input()).toHaveValue('a@example.com\n');
    rerender(field(['b@example.com']));
    expect(input()).toHaveValue('b@example.com');
    expect(screen.queryByTestId('admin-save-bar')).toBeNull();
  });
});

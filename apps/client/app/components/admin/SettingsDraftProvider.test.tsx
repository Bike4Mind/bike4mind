import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SettingsDraftProvider, useSettingsDraft } from './SettingsDraftProvider';

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle' }),
  useRouter: () => ({
    state: { location: { pathname: '/admin', search: { tab: 'admin-settings' } } },
    navigate: vi.fn(),
  }),
}));
const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

function Field({ id, save }: { id: string; save(value: string): Promise<unknown> }) {
  const draft = useSettingsDraft(id, 'stored', {
    name: `Setting ${id}`,
    save,
    blocked: value => (value === 'invalid' ? 'Choose a valid value' : undefined),
  });
  return (
    <input
      data-testid={`draft-${id}-input`}
      value={draft.value}
      onChange={event => draft.setValue(event.target.value)}
    />
  );
}

describe('SettingsDraftProvider', () => {
  it('saves a retained draft after its editor unmounts', async () => {
    const save = vi.fn().mockResolvedValue({});
    function Example() {
      const [shown, setShown] = useState(true);
      return (
        <SettingsDraftProvider>
          <button data-testid="hide-editor-btn" onClick={() => setShown(false)}>
            Hide
          </button>
          {shown && <Field id="hidden" save={save} />}
        </SettingsDraftProvider>
      );
    }
    render(<Example />, { wrapper });
    fireEvent.change(screen.getByTestId('draft-hidden-input'), { target: { value: 'retained' } });
    fireEvent.click(screen.getByTestId('hide-editor-btn'));
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() => expect(save).toHaveBeenCalledWith('retained'));
    await waitFor(() => expect(screen.queryByTestId('admin-save-bar')).toBeNull());
  });

  it('retains edits across editor unmounts and discards without sending writes', () => {
    const save = vi.fn();
    function Example() {
      const [shown, setShown] = useState(true);
      return (
        <SettingsDraftProvider>
          <button data-testid="toggle-editor-btn" onClick={() => setShown(!shown)}>
            Toggle
          </button>
          {shown && <Field id="one" save={save} />}
        </SettingsDraftProvider>
      );
    }
    render(<Example />, { wrapper });
    fireEvent.change(screen.getByTestId('draft-one-input'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByTestId('toggle-editor-btn'));
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    fireEvent.click(screen.getByTestId('toggle-editor-btn'));
    expect(screen.getByTestId('draft-one-input')).toHaveValue('draft');
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(screen.getByTestId('draft-one-input')).toHaveValue('stored');
    expect(save).not.toHaveBeenCalled();
  });

  it('retains failed and unattempted writes but removes successful ones', async () => {
    const saved = vi.fn().mockResolvedValue({});
    const failed = vi.fn().mockRejectedValue(new Error('Try again'));
    render(
      <SettingsDraftProvider>
        <Field id="one" save={saved} />
        <Field id="two" save={failed} />
      </SettingsDraftProvider>,
      { wrapper }
    );
    fireEvent.change(screen.getByTestId('draft-one-input'), { target: { value: 'first' } });
    fireEvent.change(screen.getByTestId('draft-two-input'), { target: { value: 'second' } });
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Setting two was not saved: Try again. Saved: Setting one.')
    );
    expect(saved).toHaveBeenCalledWith('first');
    expect(failed).toHaveBeenCalledWith('second');
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('1 unsaved change');
    expect(screen.getByTestId('draft-two-input')).toHaveValue('second');
  });

  it('blocks invalid drafts from keyboard submission', () => {
    const save = vi.fn();
    render(
      <SettingsDraftProvider>
        <Field id="one" save={save} />
      </SettingsDraftProvider>,
      { wrapper }
    );
    fireEvent.change(screen.getByTestId('draft-one-input'), { target: { value: 'invalid' } });
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Setting one: Choose a valid value');
  });
});

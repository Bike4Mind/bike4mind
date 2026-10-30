import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { SaveBar } from './SaveBar';

const theme = extendTheme({ ...getThemeConfig() });
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
);

describe('SaveBar', () => {
  it('shows the dirty count and supports discard, save and both save shortcuts', () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<SaveBar count={3} onSave={onSave} onDiscard={onDiscard} />, { wrapper });
    expect(screen.getByTestId('admin-save-bar')).toHaveTextContent('3 unsaved changes');
    fireEvent.click(screen.getByTestId('admin-save-confirm-btn'));
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByTestId('admin-save-discard-btn'));
    expect(onDiscard).toHaveBeenCalledOnce();
  });

  it('blocks invalid and pending saves and removes its shortcut on unmount', () => {
    const onSave = vi.fn();
    const { rerender, unmount } = render(
      <SaveBar count={1} blockedReason="Choose a value" onSave={onSave} onDiscard={vi.fn()} />,
      { wrapper }
    );
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a value');
    expect(onSave).not.toHaveBeenCalled();
    rerender(<SaveBar count={1} pending onSave={onSave} onDiscard={vi.fn()} />);
    fireEvent.keyDown(window, { key: 's', metaKey: true });
    expect(onSave).not.toHaveBeenCalled();
    unmount();
    expect(fireEvent.keyDown(window, { key: 's', metaKey: true })).toBe(true);
  });
});

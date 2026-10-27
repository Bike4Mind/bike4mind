import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminCommandPalette, type AdminCommand } from './AdminCommandPalette';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
const theme = extendTheme({ ...getThemeConfig() });
const setup = (commands: AdminCommand[] = []) =>
  render(
    <CssVarsProvider theme={theme}>
      <div data-admin-surface>
        <input data-testid="local-search" data-admin-search />
        <div contentEditable suppressContentEditableWarning data-testid="editable">
          <span data-testid="editable-child">Text</span>
        </div>
        <AdminCommandPalette commands={commands} />
      </div>
    </CssVarsProvider>
  );

describe('AdminCommandPalette', () => {
  it('opens a labelled palette, navigates with arrows and Enter, and closes', async () => {
    setup();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Admin commands');
    const input = screen.getByTestId('admin-search-input');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-controls', 'admin-command-results');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', 'admin-command-organizations');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'organizations' } }));
    expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument();
  });

  it('restores opener focus on Escape and traps Tab within the palette', async () => {
    const user = userEvent.setup();
    setup();
    const opener = screen.getByTestId('admin-command-open-btn');
    await user.click(opener);
    for (let index = 0; index < 8; index++) {
      await user.tab();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not run shortcuts in inputs, editable descendants, modifiers or dialogs', () => {
    const run = vi.fn();
    setup([{ id: 'credits', label: 'Adjust credits', shortcut: 'c', run }]);
    fireEvent.keyDown(screen.getByTestId('local-search'), { key: 'c' });
    fireEvent.keyDown(screen.getByTestId('editable-child'), { key: 'c' });
    fireEvent.keyDown(document.body, { key: 'c', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'c', repeat: true });
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(run).toHaveBeenCalledOnce();
    fireEvent.keyDown(document.body, { key: '?' });
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Admin keyboard shortcuts');
    fireEvent.keyDown(screen.getByTestId('admin-shortcuts-close-btn'), { key: 'c' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('focuses the local search and ignores input typing', () => {
    setup();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('local-search')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('local-search'), { key: 'k', ctrlKey: true });
    expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument();
  });

  it('opens a user by validated ID without sending entity searches', async () => {
    setup();
    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    const input = screen.getByTestId('admin-search-input');
    const userId = 'a'.repeat(24);
    fireEvent.change(input, { target: { value: userId } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/admin/users/$userId', params: { userId } }));
  });
});

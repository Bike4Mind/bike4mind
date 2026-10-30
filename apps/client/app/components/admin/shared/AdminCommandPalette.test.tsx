import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => {
    navigate.mockReset();
  });

  it('blocks disabled commands from clicks, shortcuts and Enter until enabled', async () => {
    const run = vi.fn();
    const renderPalette = (disabled: boolean) => (
      <CssVarsProvider theme={theme}>
        <AdminCommandPalette commands={[{ id: 'suspend', label: 'Suspend account', shortcut: 's', disabled, run }]} />
      </CssVarsProvider>
    );
    const view = render(renderPalette(true));
    const toolbarButton = screen.getByTestId('admin-command-suspend-btn');
    expect(toolbarButton).toBeDisabled();
    fireEvent.click(toolbarButton);
    fireEvent.keyDown(document.body, { key: 's' });
    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    const input = screen.getByTestId('admin-search-input');
    fireEvent.change(input, { target: { value: 'Suspend' } });
    const result = screen.getByRole('option', { name: 'Suspend account' });
    expect(result).toBeDisabled();
    fireEvent.click(result);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(run).not.toHaveBeenCalled();
    expect(input).toBeInTheDocument();

    view.rerender(renderPalette(false));
    expect(screen.getByRole('option', { name: 'Suspend account' })).toBeEnabled();
    fireEvent.keyDown(screen.getByTestId('admin-search-input'), { key: 'Enter' });
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 's' });
    expect(run).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('admin-command-suspend-btn'));
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('keeps a paletteOnly command out of the button strip but in the palette and shortcuts', async () => {
    const run = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <AdminCommandPalette
          commands={[
            { id: 'credits', label: 'Adjust credits', shortcut: 'c', paletteOnly: true, run },
            { id: 'revoke', label: 'Revoke API keys', run: vi.fn() },
          ]}
        />
      </CssVarsProvider>
    );
    expect(screen.queryByTestId('admin-command-credits-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('admin-command-revoke-btn')).toBeInTheDocument();
    expect(screen.getByTestId('admin-shortcuts-open-btn')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'c' });
    expect(run).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    fireEvent.change(screen.getByTestId('admin-search-input'), { target: { value: 'Adjust' } });
    fireEvent.click(screen.getByRole('option', { name: 'Adjust credits' }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('opens the mounted Help Center through its host callback', async () => {
    const onOpenHelp = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <AdminCommandPalette onOpenHelp={onOpenHelp} />
      </CssVarsProvider>
    );
    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    const input = screen.getByTestId('admin-search-input');
    fireEvent.change(input, { target: { value: 'Help Center' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onOpenHelp).toHaveBeenCalledExactlyOnceWith());
    expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument();
  });

  it('does not execute Enter during composition or after unmount', async () => {
    const run = vi.fn();
    const view = setup([{ id: 'credits', label: 'Adjust credits', run }]);
    fireEvent.click(screen.getByTestId('admin-command-open-btn'));
    const input = screen.getByTestId('admin-search-input');
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.getByTestId('admin-search-input')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    view.unmount();
    await new Promise(resolve => window.setTimeout(resolve, 10));
    expect(run).not.toHaveBeenCalled();
  });

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

  it('routes section commands through onNavigate instead of the router when provided', async () => {
    navigate.mockClear();
    const onNavigate = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <AdminCommandPalette commands={[]} onNavigate={onNavigate} />
      </CssVarsProvider>
    );
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const input = screen.getByTestId('admin-search-input');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    expect(navigate).not.toHaveBeenCalled();
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

  it('still runs shortcuts past a closed dialog left mounted under an aria-hidden root', () => {
    const run = vi.fn();
    setup([{ id: 'credits', label: 'Adjust credits', shortcut: 'c', run }]);
    const hidden = document.createElement('div');
    hidden.setAttribute('aria-hidden', 'true');
    hidden.innerHTML = '<div role="dialog"></div>';
    document.body.appendChild(hidden);
    try {
      fireEvent.keyDown(document.body, { key: 'c' });
      expect(run).toHaveBeenCalledOnce();
    } finally {
      hidden.remove();
    }
  });

  it('focuses the local search, and opens the palette from an input with Cmd/Ctrl+K', () => {
    setup();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByTestId('local-search')).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId('local-search'), { key: 'k', ctrlKey: true, isComposing: true });
    expect(screen.queryByTestId('admin-search-input')).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId('local-search'), { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('admin-search-input')).toHaveFocus();
  });

  it('wins `/` over a bubble-phase window listener such as the sidebar filter', () => {
    const sidebarFilter = vi.fn((event: KeyboardEvent) => {
      if (!event.defaultPrevented) event.preventDefault();
    });
    window.addEventListener('keydown', sidebarFilter);
    try {
      setup();
      fireEvent.keyDown(document.body, { key: '/' });
      expect(screen.getByTestId('local-search')).toHaveFocus();
      expect(sidebarFilter.mock.calls[0][0].defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('keydown', sidebarFilter);
    }
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

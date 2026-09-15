import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ChatPanelControls from './ChatPanelControls';

// The copy button's hook reaches SessionsContext and react-query, neither of which the
// header's own wiring depends on. `copyState` is mutable so a test can render the
// post-copy state without driving the hook's 2s reset timer.
const { copyMarkdown, copyState } = vi.hoisted(() => ({
  copyMarkdown: vi.fn(),
  copyState: { copied: false },
}));
vi.mock('./useCopySessionMarkdown', () => ({
  useCopySessionMarkdown: () => ({ copyMarkdown, copied: copyState.copied }),
}));

const appTheme = extendTheme({ ...getThemeConfig() });

const PREFIX = 'docked-chat';

const renderControls = (props: Partial<React.ComponentProps<typeof ChatPanelControls>> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ChatPanelControls testIdPrefix={PREFIX} {...props} />
    </CssVarsProvider>
  );

const trigger = () => screen.getByTestId(`${PREFIX}-layout-select-btn`);
const openMenu = () => fireEvent.click(trigger());
const openOptionLabels = () =>
  within(screen.getByTestId(`${PREFIX}-layout-listbox`))
    .getAllByRole('option')
    .map(option => option.textContent);

beforeEach(() => {
  copyMarkdown.mockClear();
  copyState.copied = false;
  // Distinct from every value the menu can write, so each assertion below fails if the
  // selection never reaches the store.
  setSessionLayout({ layout: 'hide' });
});

describe('ChatPanelControls layout menu', () => {
  it('writes the picked dock direction to the session layout', () => {
    renderControls({ activeLayout: 'dockRight' });

    openMenu();
    fireEvent.click(screen.getByRole('option', { name: 'Dock bottom' }));

    expect(useSessionLayout.getState().layout).toBe('dockBottom');
  });

  // The label and the persisted name deliberately disagree (see LAYOUT_LABELS), so this is
  // the assertion that catches the mapping silently inverting.
  it('maps the "Dock left" label onto the dockRight layout name', () => {
    renderControls({ activeLayout: 'dockBottom' });

    openMenu();
    fireEvent.click(screen.getByRole('option', { name: 'Dock left' }));

    expect(useSessionLayout.getState().layout).toBe('dockRight');
  });

  it('writes floatingChat when Float is offered and picked', () => {
    renderControls({ activeLayout: 'dockRight', showFloat: true });

    openMenu();
    fireEvent.click(screen.getByRole('option', { name: 'Float' }));

    expect(useSessionLayout.getState().layout).toBe('floatingChat');
  });

  it('offers only the dock directions without showFloat', () => {
    renderControls({ activeLayout: 'dockRight' });

    openMenu();

    expect(openOptionLabels()).toEqual(['Dock left', 'Dock bottom']);
  });

  it('offers Float alongside the dock directions with showFloat', () => {
    renderControls({ activeLayout: 'dockRight', showFloat: true });

    openMenu();

    expect(openOptionLabels()).toEqual(['Dock left', 'Dock bottom', 'Float']);
  });

  // The floating window passes no activeLayout, so no Option matches and Joy would otherwise
  // leave the trigger blank.
  it('falls back to the "Layout" placeholder when no layout is active', () => {
    renderControls();

    expect(trigger()).toHaveTextContent('Layout');
  });

  it('names the active layout on the trigger', () => {
    renderControls({ activeLayout: 'dockBottom' });

    expect(trigger()).toHaveTextContent('Dock bottom');
  });

  // Two panels mount this cluster under different prefixes, so every testid the rest of
  // this suite reads is only meaningful if the prop actually reaches them.
  it("prefixes its testids with the caller's prefix", () => {
    renderControls({ testIdPrefix: 'floating-chat' });

    fireEvent.click(screen.getByTestId('floating-chat-layout-select-btn'));

    expect(screen.getByTestId('floating-chat-layout-listbox')).toBeInTheDocument();
    expect(screen.getByTestId('floating-chat-copy-markdown')).toBeInTheDocument();
  });
});

describe('ChatPanelControls copy button', () => {
  it('copies the chat as Markdown on click', () => {
    renderControls({ activeLayout: 'dockRight' });

    fireEvent.click(screen.getByTestId(`${PREFIX}-copy-markdown`));

    expect(copyMarkdown).toHaveBeenCalledTimes(1);
  });

  it('swaps the copy icon for a tick once a copy has landed', () => {
    copyState.copied = true;
    renderControls({ activeLayout: 'dockRight' });

    expect(screen.getByTestId('CheckIcon')).toBeInTheDocument();
    expect(screen.queryByTestId('ContentCopyIcon')).not.toBeInTheDocument();
  });
});

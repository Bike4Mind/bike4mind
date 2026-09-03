import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import FloatingChatWindow from './FloatingChatWindow';

// The control cluster reaches SessionsContext/react-query through useCopySessionMarkdown,
// which is irrelevant to the close-button wiring under test.
vi.mock('./ChatPanelControls', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('FloatingChatWindow', () => {
  beforeEach(() => {
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: false });
  });

  it('dismisses the window instead of re-docking when the close button is clicked', () => {
    render(
      <Wrapper>
        <FloatingChatWindow>chat</FloatingChatWindow>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('floating-chat-close'));

    expect(useSessionLayout.getState().layout).toBe('hide');
  });

  // The other half of DockedChatPanel's "Hide chat": the pill is a waypoint back to the
  // dock, so expanding it must not strand the chat in a floating window.
  it.each(['dockRight', 'dockBottom'] as const)('expands back into the %s that hid the chat here', dock => {
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: true, hiddenFromLayout: dock });
    render(
      <Wrapper>
        <FloatingChatWindow>chat</FloatingChatWindow>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('floating-chat-minimized'));

    const state = useSessionLayout.getState();
    expect(state.layout).toBe(dock);
    expect(state.floatingChatMinimized).toBe(false);
    expect(state.hiddenFromLayout).toBeUndefined();
  });

  it('stays floating when the pill was minimized rather than hidden from a dock', () => {
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: true, hiddenFromLayout: undefined });
    render(
      <Wrapper>
        <FloatingChatWindow>chat</FloatingChatWindow>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('floating-chat-minimized'));

    const state = useSessionLayout.getState();
    expect(state.layout).toBe('floatingChat');
    expect(state.floatingChatMinimized).toBe(false);
  });
});

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import DockedChatPanel from './DockedChatPanel';

// The control cluster reaches SessionsContext/react-query through useCopySessionMarkdown,
// which is irrelevant to the header's minimize wiring.
vi.mock('./ChatPanelControls', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

describe('DockedChatPanel', () => {
  beforeEach(() => {
    setSessionLayout({ layout: 'dockRight', floatingChatMinimized: false, previousLayout: undefined });
  });

  it('minimizes to the AI Chat launcher instead of switching to the floating window', () => {
    render(
      <Wrapper>
        <DockedChatPanel>chat</DockedChatPanel>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('docked-chat-close'));

    const state = useSessionLayout.getState();
    expect(state.floatingChatMinimized).toBe(true);
    expect(state.layout).toBe('floatingChat');
  });

  it('records the dock it was minimized from so the float window can close back to it', () => {
    setSessionLayout({ layout: 'dockBottom' });
    render(
      <Wrapper>
        <DockedChatPanel>chat</DockedChatPanel>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('docked-chat-close'));

    expect(useSessionLayout.getState().previousLayout).toBe('dockBottom');
  });
});

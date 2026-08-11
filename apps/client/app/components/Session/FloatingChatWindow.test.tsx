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
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: false, previousLayout: 'dockRight' });
  });

  it('dismisses the window instead of re-docking when the close button is clicked', () => {
    render(
      <Wrapper>
        <FloatingChatWindow>chat</FloatingChatWindow>
      </Wrapper>
    );

    fireEvent.click(screen.getByTestId('floating-chat-close'));

    const state = useSessionLayout.getState();
    expect(state.layout).toBe('hide');
    expect(state.previousLayout).toBeUndefined();
  });
});

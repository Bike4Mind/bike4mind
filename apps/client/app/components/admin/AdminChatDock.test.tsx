import React, { useEffect, useRef } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import DockedChatPanel from '@client/app/components/Session/DockedChatPanel';
import FloatingChatWindow from '@client/app/components/Session/FloatingChatWindow';
import AdminChatDock from './AdminChatDock';

vi.mock('@client/app/components/Session/ChatPanelControls', () => ({
  default: () => null,
  chatHeaderToolButtonSx: {},
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const setWide = (wide: boolean) =>
  vi.mocked(window.matchMedia).mockImplementation(
    query =>
      ({
        matches: wide,
        media: query,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }) as unknown as MediaQueryList
  );

// Swaps the docked panel and the floating window by layout, as SessionContainer does.
const ChatSwitcher = () => {
  const layout = useSessionLayout(s => s.layout);
  return layout === 'floatingChat' ? (
    <FloatingChatWindow closeToPill>chat</FloatingChatWindow>
  ) : (
    <DockedChatPanel>chat</DockedChatPanel>
  );
};

const renderDock = (chat: React.ReactNode = <div>chat</div>) =>
  render(
    <Wrapper>
      <AdminChatDock content={<div data-testid="content">content</div>} chat={chat} />
    </Wrapper>
  );

const style = (testId: string) => getComputedStyle(screen.getByTestId(testId));

describe('AdminChatDock', () => {
  beforeEach(() => {
    setWide(true);
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: true, hiddenFromLayout: undefined });
  });

  it('puts the chat in flow on the left when docked right', () => {
    setSessionLayout({ layout: 'dockRight' });
    renderDock();

    expect(style('admin-chat-dock').flexDirection).toBe('row-reverse');
    expect(style('admin-chat-slot').position).not.toBe('absolute');
    expect(style('admin-chat-slot').width).toBe(`${useSessionLayout.getState().dockChatWidth}%`);
  });

  it('puts the chat in flow below the content when docked bottom', () => {
    setSessionLayout({ layout: 'dockBottom' });
    renderDock();

    expect(style('admin-chat-dock').flexDirection).toBe('column');
    expect(style('admin-chat-slot').position).not.toBe('absolute');
    expect(style('admin-chat-slot').height).toBe(`${useSessionLayout.getState().dockChatHeight}%`);
  });

  it('stacks the chat under the content below the md breakpoint', () => {
    setWide(false);
    setSessionLayout({ layout: 'dockRight' });
    renderDock();

    expect(style('admin-chat-dock').flexDirection).toBe('column');
    expect(style('admin-chat-slot').position).not.toBe('absolute');
  });

  it.each(['floatingChat', 'hide'] as const)('keeps the chat slot clipped for %s', layout => {
    setSessionLayout({ layout });
    renderDock();

    expect(style('admin-chat-slot').position).toBe('absolute');
    expect(style('admin-chat-slot').width).toBe('0px');
    expect(style('admin-chat-slot').height).toBe('0px');
    expect(screen.getByTestId('content')).toBeTruthy();
  });

  it('does not remount the chat when the layout changes', () => {
    const mounts = vi.fn();
    const Probe = () => {
      const counted = useRef(false);
      useEffect(() => {
        if (!counted.current) mounts();
        counted.current = true;
      }, []);
      return <div>chat</div>;
    };
    renderDock(<Probe />);

    for (const layout of ['dockRight', 'floatingChat', 'dockBottom', 'hide'] as const) {
      act(() => setSessionLayout({ layout }));
    }

    expect(mounts).toHaveBeenCalledTimes(1);
  });

  it('round-trips Hide chat and the pill with the real panel and pill', () => {
    setSessionLayout({ layout: 'dockRight' });
    renderDock(<ChatSwitcher />);
    expect(style('admin-chat-slot').position).not.toBe('absolute');

    fireEvent.click(screen.getByTestId('docked-chat-close'));
    expect(useSessionLayout.getState().layout).toBe('floatingChat');
    expect(useSessionLayout.getState().hiddenFromLayout).toBe('dockRight');
    expect(style('admin-chat-slot').position).toBe('absolute');

    fireEvent.click(screen.getByTestId('floating-chat-minimized'));
    const state = useSessionLayout.getState();
    expect(state.layout).toBe('dockRight');
    expect(state.floatingChatMinimized).toBe(false);
    expect(style('admin-chat-slot').position).not.toBe('absolute');
    expect(screen.getByTestId('docked-chat-close')).toBeTruthy();
  });
});

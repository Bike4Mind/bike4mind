import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useAdminChatLayout } from './useAdminChatLayout';

beforeEach(() => {
  setSessionLayout({ layout: 'hide', floatingChatMinimized: false });
});

describe('useAdminChatLayout', () => {
  it('mounts the assistant as the minimized floating pill', () => {
    renderHook(() => useAdminChatLayout(true));

    const state = useSessionLayout.getState();
    expect(state.layout).toBe('floatingChat');
    expect(state.floatingChatMinimized).toBe(true);
  });

  // Opening an artifact from the chat writes 'vertical'; on /admin that layout renders the chat
  // inside the zero-size box, so it has to land back in the floating window.
  it.each(['vertical', 'dockRight', 'dockBottom', 'horizontal'] as const)(
    'pulls a %s layout back to the floating window',
    layout => {
      renderHook(() => useAdminChatLayout(true));
      // Expanded, as it is once the admin opens the pill: landing back in the floating window
      // must not also collapse it to the pill, or every artifact click would close the chat.
      act(() => setSessionLayout({ floatingChatMinimized: false }));

      act(() => setSessionLayout({ layout }));

      const state = useSessionLayout.getState();
      expect(state.layout).toBe('floatingChat');
      expect(state.floatingChatMinimized).toBe(false);
    }
  );

  it('keeps the artifact an in-chat action opened', () => {
    renderHook(() => useAdminChatLayout(true));
    const artifactData = { id: 'a1', type: 'code', content: 'x' } as never;

    act(() => setSessionLayout({ layout: 'vertical', artifactData }));

    expect(useSessionLayout.getState().layout).toBe('floatingChat');
    expect(useSessionLayout.getState().artifactData).toBe(artifactData);
  });

  it('releases the layout and resets it on unmount', () => {
    const { unmount } = renderHook(() => useAdminChatLayout(true));

    unmount();
    act(() => setSessionLayout({ layout: 'vertical' }));

    expect(useSessionLayout.getState().layout).toBe('vertical');
  });

  it('leaves the reset layout in place on unmount', () => {
    const { unmount } = renderHook(() => useAdminChatLayout(true));

    unmount();

    const state = useSessionLayout.getState();
    expect(state.layout).toBe('hide');
    expect(state.floatingChatMinimized).toBe(false);
  });

  it('does nothing for a non-admin', () => {
    renderHook(() => useAdminChatLayout(false));

    act(() => setSessionLayout({ layout: 'vertical' }));

    expect(useSessionLayout.getState().layout).toBe('vertical');
  });
});

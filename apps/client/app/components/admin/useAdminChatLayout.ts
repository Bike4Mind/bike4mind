import { useEffect } from 'react';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

/**
 * Keeps the admin assistant in the floating window while the page is mounted. AdminPage renders
 * the chat inside a zero-size box that only the floating window and its pill escape, so any other
 * layout an in-chat action writes (a dock, the artifact split) would leave the chat invisible.
 */
export function useAdminChatLayout(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    setSessionLayout({ layout: 'floatingChat', floatingChatMinimized: true });
    const unsubscribe = useSessionLayout.subscribe(state => {
      if (state.layout !== 'floatingChat') setSessionLayout({ layout: 'floatingChat' });
    });
    return () => {
      // Unsubscribe first, or the reset below would be pulled straight back to floatingChat.
      unsubscribe();
      // Reset the minimized default too, or the next floating chat opened elsewhere starts as the pill
      setSessionLayout({ layout: 'hide', floatingChatMinimized: false });
    };
  }, [enabled]);
}

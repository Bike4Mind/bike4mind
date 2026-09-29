import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';

interface MobileHeaderState {
  title: string | null;
  action: ReactNode;
}

/**
 * What the phone's app header (layouts/Notebook/Header.tsx) shows besides the
 * menu button. The header is shared by every page and the page is rendered in a
 * different tree, so a page hands its title across through this store.
 */
export const useMobileHeaderStore = create<MobileHeaderState>(() => ({ title: null, action: null }));

/**
 * Name the current page in the phone header, with an optional action on the
 * right. Opt-in: a page that never calls this leaves the header as it was.
 * Pass a stable `action` element, or the header re-renders on every page render.
 */
export function useMobileHeader(title: string, action?: ReactNode) {
  useEffect(() => {
    useMobileHeaderStore.setState({ title, action: action ?? null });
    return () => useMobileHeaderStore.setState({ title: null, action: null });
  }, [title, action]);
}

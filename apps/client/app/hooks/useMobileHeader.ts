import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';

interface MobileHeaderState {
  title: string | null;
  action: ReactNode;
  /** Identity of the useMobileHeader call that set the slot, so only it can clear it. */
  owner: symbol | null;
}

/**
 * What the phone's app header (layouts/Notebook/Header.tsx) shows besides the
 * menu button. The header is shared by every page and the page is rendered in a
 * different tree, so a page hands its title across through this store.
 */
export const useMobileHeaderStore = create<MobileHeaderState>(() => ({ title: null, action: null, owner: null }));

/**
 * Name the current page in the phone header, with an optional action on the
 * right. Opt-in: a page that never calls this leaves the header as it was.
 * Pass a stable `action` element, or the header re-renders on every page render.
 */
export function useMobileHeader(title: string, action?: ReactNode) {
  useEffect(() => {
    const owner = Symbol('mobileHeader');
    useMobileHeaderStore.setState({ title, action: action ?? null, owner });
    // Clear only our own entry: in a route change the next page's effect can run
    // before this cleanup, and an unconditional clear would wipe its title.
    return () => {
      if (useMobileHeaderStore.getState().owner === owner) {
        useMobileHeaderStore.setState({ title: null, action: null, owner: null });
      }
    };
  }, [title, action]);
}

import { useCallback, useState } from 'react';
import { SIDEBAR_COLLAPSED_STORAGE_KEY, SIDEBAR_MORE_STORAGE_KEY } from './adminSidebarConfig';

const readStored = <T>(key: string): T | null => {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as T) : null;
  } catch {
    // Malformed storage reads as no preference at all.
    return null;
  }
};

const persist = (key: string, value: unknown) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort; ignore quota/serialization failures.
  }
};

/** Which long sidebar sections the admin has opened past their "More" row; persisted per browser. */
export function useAdminSidebarMore(): { isMoreOpen: (key: string) => boolean; toggleMore: (key: string) => void } {
  const [openSections, setOpenSections] = useState<string[]>(() => {
    const stored = readStored<unknown>(SIDEBAR_MORE_STORAGE_KEY);
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [];
  });

  const isMoreOpen = (key: string) => openSections.includes(key);

  const toggleMore = useCallback((key: string) => {
    setOpenSections(previous => {
      const next = previous.includes(key) ? previous.filter(open => open !== key) : [...previous, key];
      persist(SIDEBAR_MORE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { isMoreOpen, toggleMore };
}

/** Whether the desktop sidebar is folded to its icon rail; persisted per browser. */
export function useAdminSidebarCollapsed(): { collapsed: boolean; toggleCollapsed: () => void } {
  const [collapsed, setCollapsed] = useState(() => readStored<boolean>(SIDEBAR_COLLAPSED_STORAGE_KEY) === true);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(previous => {
      persist(SIDEBAR_COLLAPSED_STORAGE_KEY, !previous);
      return !previous;
    });
  }, []);

  return { collapsed, toggleCollapsed };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecentFolder } from '@shared/chat';

export interface RecentFolders {
  folders: readonly RecentFolder[];
  /** Re-read from main: which folders still exist can change while the window is open. */
  refresh: () => void;
  remove: (path: string) => Promise<void>;
}

/** The folder chip's Recent list, read on mount and again whenever its menu opens. */
export function useRecentFolders(): RecentFolders {
  const [folders, setFolders] = useState<readonly RecentFolder[]>([]);
  const live = useRef(true);

  const refresh = useCallback(() => {
    void window.b4m.chat.listRecentFolders().then(
      listed => live.current && setFolders(listed),
      // A list that cannot be read leaves "Open folder..." working, which is the one entry that matters.
      (error: unknown) => console.warn('Could not read recent folders', error)
    );
  }, []);

  const remove = useCallback(async (path: string) => {
    try {
      const left = await window.b4m.chat.removeRecentFolder(path);
      if (live.current) setFolders(left);
    } catch (error) {
      console.warn('Could not remove recent folder', error);
    }
  }, []);

  useEffect(() => {
    live.current = true;
    refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  return { folders, refresh, remove };
}

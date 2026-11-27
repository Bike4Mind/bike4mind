import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecentFolder } from '@shared/chat';
import { hostChat } from '../host/hostChat';

export interface RecentFolders {
  folders: readonly RecentFolder[];
  /** Re-read from main: which folders still exist can change while the window is open. */
  refresh: () => void;
  remove: (path: string) => Promise<void>;
}

/** `hostId`'s Recent folder list, read on mount, on a host change and again whenever a menu opens. */
export function useRecentFolders(hostId: string): RecentFolders {
  const [folders, setFolders] = useState<readonly RecentFolder[]>([]);
  const live = useRef(true);
  // Only the latest request may apply: a refresh still in flight must not restore a removed entry.
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const id = ++latest.current;
    void hostChat.listRecentFolders(hostId).then(
      listed => live.current && id === latest.current && setFolders(listed),
      // A list that cannot be read leaves "Open folder..." working, which is the one entry that matters.
      (error: unknown) => console.warn('Could not read recent folders', error)
    );
  }, [hostId]);

  const remove = useCallback(
    async (path: string) => {
      const id = ++latest.current;
      try {
        const left = await hostChat.removeRecentFolder(hostId, path);
        if (live.current && id === latest.current) setFolders(left);
      } catch (error) {
        console.warn('Could not remove recent folder', error);
      }
    },
    [hostId]
  );

  useEffect(() => {
    live.current = true;
    refresh();
    return () => {
      live.current = false;
    };
  }, [refresh]);

  return { folders, refresh, remove };
}

import { useEffect, useState } from 'react';
import type { MiniTavernApi } from '@shared/ipc';
import { EMPTY_WATCH_SNAPSHOT, type WatchSnapshot } from '@shared/watch';

/** The mini window's bridge (preload/mini.ts); undefined in any other window. */
export function miniApi(): MiniTavernApi | undefined {
  return window.b4mMini;
}

/** The latest watch snapshot main pushed, seeded with a pull so the first paint is not empty. */
export function useWatchSnapshot(api: MiniTavernApi | undefined): WatchSnapshot {
  const [snapshot, setSnapshot] = useState<WatchSnapshot>(EMPTY_WATCH_SNAPSHOT);
  useEffect(() => {
    if (!api) return;
    let live = true;
    const unsubscribe = api.onSnapshot(next => {
      live = false;
      setSnapshot(next);
    });
    // A push that lands first is newer than this pull's answer, which is then dropped.
    void api.getSnapshot().then(first => {
      if (live) setSnapshot(first);
    });
    return unsubscribe;
  }, [api]);
  return snapshot;
}

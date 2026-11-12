import { useCallback, useEffect, useState } from 'react';
import { pickRoom, type RoomChoice, type WatchSnapshot } from '@shared/watch';

export interface RoomSelection extends RoomChoice {
  /** 1-based position of the shown room, and how many there are, for the "2 of 3" pager. */
  position: number;
  count: number;
  /** Show the next (+1) or previous (-1) orchestration, pinning it. */
  step(delta: 1 | -1): void;
  unpin(): void;
}

/**
 * Which orchestration the mini Tavern shows: it follows attention until the user picks one, and
 * the pick holds until they unpin it or that orchestration finishes (see pickRoom).
 */
export function useRoomSelection(snapshot: WatchSnapshot): RoomSelection {
  const [pinned, setPinned] = useState<string | null>(null);
  const choice = pickRoom(snapshot, pinned);
  const roots = snapshot.orchestrations.map(orchestration => orchestration.rootId);
  const index = choice.rootId === null ? -1 : roots.indexOf(choice.rootId);

  const finishedPinned = snapshot.orchestrations.some(
    orchestration => orchestration.rootId === pinned && orchestration.celebrate
  );
  useEffect(() => {
    if (finishedPinned) setPinned(null);
  }, [finishedPinned]);

  const step = (delta: 1 | -1) => {
    if (roots.length === 0) return;
    const from = index === -1 ? 0 : index;
    setPinned(roots[(from + delta + roots.length) % roots.length]);
  };
  const unpin = useCallback(() => setPinned(null), []);

  return { ...choice, position: index + 1, count: roots.length, step, unpin };
}

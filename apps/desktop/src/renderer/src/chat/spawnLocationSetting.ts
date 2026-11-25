import { useCallback, useEffect, useState } from 'react';
import { defaultSpawnPlacement, type SpawnSuggestionPlacement } from '@shared/chat';
import { DEFAULT_SPAWN_LOCATION, SPAWN_LOCATION_TEXT, type SpawnLocation } from '@shared/spawnLocation';

/**
 * Where a suggested session starts; main holds it because main does the automatic start (see
 * ChatService.autoStartSuggestion). A change from any window is pushed back to every window.
 */
export function useSpawnLocation(): [SpawnLocation, (location: SpawnLocation) => void] {
  const [location, setLocation] = useState<SpawnLocation>(DEFAULT_SPAWN_LOCATION);
  useEffect(() => {
    let live = true;
    void window.b4m.chat
      .getSpawnLocation()
      .then(stored => live && setLocation(stored))
      .catch((error: unknown) => console.warn('Could not load the new agent session setting.', error));
    const off = window.b4m.chat.onSpawnLocation(next => live && setLocation(next));
    return () => {
      live = false;
      off();
    };
  }, []);
  const change = useCallback((next: SpawnLocation) => {
    void window.b4m.chat
      .setSpawnLocation(next)
      .then(setLocation)
      .catch((error: unknown) => console.warn('Could not change the new agent session setting.', error));
  }, []);
  return [location, change];
}

export function spawnLocationSummary(location: SpawnLocation): string {
  return SPAWN_LOCATION_TEXT[location].hint;
}

/**
 * The card's first choice: the Settings location, unless it names a worktree outside a git
 * repository, or is 'ask', where the shared default rule decides.
 */
export function initialSpawnChoice(location: SpawnLocation, repository: boolean): SpawnSuggestionPlacement {
  if (location === 'local') return 'local';
  if (location === 'worktree' && repository) return 'worktree';
  return defaultSpawnPlacement(repository);
}

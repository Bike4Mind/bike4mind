/**
 * Where a session_spawn suggestion goes when the user has not picked otherwise, from Settings.
 * 'worktree' and 'local' start it without a location question (see ChatService.suggestionHost for
 * how the approval mode decides between an automatic start and a one-click card); 'ask' is the
 * full card every time. App-wide, like approval-mode.json.
 */
export type SpawnLocation = 'worktree' | 'local' | 'ask';

export const SPAWN_LOCATIONS: readonly SpawnLocation[] = ['worktree', 'local', 'ask'];

export const DEFAULT_SPAWN_LOCATION: SpawnLocation = 'worktree';

export const SPAWN_LOCATION_FILE_NAME = 'spawn-location.json';

/** Anything unreadable is the default, so a corrupt file never turns the automatic start off. */
export function parseSpawnLocation(value: unknown): SpawnLocation {
  return SPAWN_LOCATIONS.includes(value as SpawnLocation) ? (value as SpawnLocation) : DEFAULT_SPAWN_LOCATION;
}

export const SPAWN_LOCATION_TEXT: Readonly<Record<SpawnLocation, { label: string; hint: string }>> = {
  worktree: {
    label: 'New worktree',
    hint: 'Each new agent session gets its own branch and checkout.',
  },
  local: {
    label: 'This folder',
    hint: 'New agent sessions share the working directory of the one that started them.',
  },
  ask: {
    label: 'Ask each time',
    hint: 'A card asks where to run every suggested session before it starts.',
  },
};

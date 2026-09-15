import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';

/**
 * Hook for managing favorite AI model IDs with optimistic local state.
 *
 * `updatePreferences` only optimistically handles SCALAR_PREF_KEYS locally,
 * so this hook maintains its own state for instant toggle feedback and syncs
 * when server preferences arrive via WebSocket.
 */
export function useFavoriteModels() {
  const currentUser = useUser(s => s.currentUser);
  const { updatePreferences } = useUserSettings();

  const serverFavorites = currentUser?.preferences?.favoriteModelIds;
  const serverFavoritesKey = serverFavorites ? JSON.stringify(serverFavorites) : '';

  const [localFavorites, setLocalFavorites] = useState<string[]>(serverFavorites ?? []);

  // Sync from server when preferences change (e.g., WebSocket update, page load)
  useEffect(() => {
    if (serverFavorites) {
      setLocalFavorites(serverFavorites);
    }
  }, [serverFavoritesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const favoriteSet = useMemo(() => new Set(localFavorites), [localFavorites]);

  const isFavorite = useCallback((modelId: string) => favoriteSet.has(modelId), [favoriteSet]);

  const toggleFavorite = useCallback(
    (modelId: string) => {
      const next = favoriteSet.has(modelId)
        ? localFavorites.filter(id => id !== modelId)
        : [...localFavorites, modelId];

      setLocalFavorites(next);
      updatePreferences({ favoriteModelIds: next });
    },
    [localFavorites, favoriteSet, updatePreferences]
  );

  return { favoriteModelIds: favoriteSet, isFavorite, toggleFavorite } as const;
}

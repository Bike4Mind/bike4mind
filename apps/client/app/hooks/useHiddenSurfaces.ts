import { useCallback } from 'react';
import { getWorkspaceSurface, isSurfaceHidden, type SurfaceId } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';

const NONE: readonly string[] = [];

/**
 * The workspace surface ids the current user hid from their own UI (`preferences.hiddenSurfaces`).
 * Read straight from the user store, which `updatePreferences` writes through to optimistically, so
 * every display point updates the moment the switch flips. Needs no UserSettingsProvider.
 */
export function useHiddenSurfaceIds(): readonly string[] {
  return useUser(s => s.currentUser?.preferences?.hiddenSurfaces) ?? NONE;
}

/**
 * Read and write the hidden-surfaces display preference. Hiding never changes access: direct URLs,
 * sessions already in the surface and route gates keep working (see `isSurfaceHidden`).
 *
 * Arrays are replaced wholesale by the server's preferences merge, so every write sends the full,
 * de-duplicated list. Only hideable registered ids are accepted.
 */
export function useHiddenSurfaces() {
  const hiddenSurfaces = useHiddenSurfaceIds();
  const { updatePreferences } = useUserSettings();

  const isHidden = useCallback((id: SurfaceId) => isSurfaceHidden(hiddenSurfaces, id), [hiddenSurfaces]);

  const setHidden = useCallback(
    (id: SurfaceId, hidden: boolean) => {
      if (!id || getWorkspaceSurface(id)?.hideable !== true) return;
      const others = hiddenSurfaces.filter(entry => entry !== id);
      const next = Array.from(new Set(hidden ? [...others, id] : others));
      updatePreferences({ hiddenSurfaces: next });
    },
    [hiddenSurfaces, updatePreferences]
  );

  return { hiddenSurfaces, isHidden, setHidden } as const;
}

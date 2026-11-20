import { useCallback, useEffect, useState } from 'react';
import type { ModelVersion, ModelVersionEntry, ModelViewState } from '@shared/model3d';

export type ModelVersions = {
  /** Oldest first. Empty until listed, and for a conversation with nothing kept. */
  versions: ModelVersionEntry[];
  /** The newest version matching the file as it is now; null when the file has changed since. */
  current: number | null;
  /** Writes `number` back to its file; main keeps the rebuild as a new version. */
  restore(number: number): Promise<ModelVersion>;
};

/** The newest kept version of exactly this file and source, the one the pane is showing. */
export function currentVersion(versions: readonly ModelVersion[], state: ModelViewState): number | null {
  if (state.kind !== 'model' || state.source === null) return null;
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index];
    if (version.path === state.path && version.source === state.source) return version.number;
  }
  return null;
}

type Listed = { sessionId: string | null; versions: ModelVersionEntry[] };

/**
 * A conversation's kept model builds (main/chat/model3d/ModelVersionStore.ts), listed again
 * whenever main says that conversation kept one.
 */
export function useModelVersions(sessionId: string | null, state: ModelViewState): ModelVersions {
  const [listed, setListed] = useState<Listed>({ sessionId: null, versions: [] });
  const versions = listed.sessionId === sessionId ? listed.versions : [];

  useEffect(() => {
    if (sessionId === null) return;
    let live = true;
    // Replies can land out of order across a burst of builds, so only the latest request's counts.
    let latest = 0;
    const load = () => {
      const request = ++latest;
      window.b4m.model.listVersions(sessionId).then(
        next => {
          if (live && request === latest) setListed({ sessionId, versions: next });
        },
        (caught: unknown) => console.warn(`Model versions could not be listed: ${String(caught)}`)
      );
    };
    const unsubscribe = window.b4m.model.onVersions(update => {
      if (update.sessionId === sessionId) load();
    });
    load();
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);

  const restore = useCallback(
    async (number: number) => {
      if (sessionId === null) throw new Error('This conversation has no model yet.');
      return window.b4m.model.restoreVersion(sessionId, number);
    },
    [sessionId]
  );

  return { versions, current: currentVersion(versions, state), restore };
}

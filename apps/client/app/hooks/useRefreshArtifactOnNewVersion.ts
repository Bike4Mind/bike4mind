import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ARTIFACT_VERSION_CREATED_EVENT } from '@client/app/utils/artifactPersistence';

/**
 * Refetches an artifact and its version list when a prompt saves a new version of it, so an
 * already-open viewer follows the new version instead of staying on the one it opened with.
 *
 * `onNewVersion` runs after the queries are invalidated, for the caller to re-attach whatever it
 * observes them through.
 */
export function useRefreshArtifactOnNewVersion(onNewVersion?: (artifactId: string) => void): void {
  const queryClient = useQueryClient();
  const onNewVersionRef = useRef(onNewVersion);

  useEffect(() => {
    onNewVersionRef.current = onNewVersion;
  }, [onNewVersion]);

  useEffect(() => {
    const onVersionCreated = (event: Event) => {
      const artifactId = (event as CustomEvent<{ artifactId?: string }>).detail?.artifactId;
      if (!artifactId) return;
      queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] });
      queryClient.invalidateQueries({ queryKey: ['artifactVersions', artifactId] });
      onNewVersionRef.current?.(artifactId);
    };

    window.addEventListener(ARTIFACT_VERSION_CREATED_EVENT, onVersionCreated);
    return () => window.removeEventListener(ARTIFACT_VERSION_CREATED_EVENT, onVersionCreated);
  }, [queryClient]);
}

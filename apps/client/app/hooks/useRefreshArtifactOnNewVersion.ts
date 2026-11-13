import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ARTIFACT_VERSION_CREATED_EVENT } from '@client/app/utils/artifactPersistence';

/**
 * Refetches an artifact and its version list when a prompt saves a new version of it, so an
 * already-open viewer follows the new version instead of staying on the one it opened with.
 */
export function useRefreshArtifactOnNewVersion(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const onVersionCreated = (event: Event) => {
      const artifactId = (event as CustomEvent<{ artifactId?: string }>).detail?.artifactId;
      if (!artifactId) return;
      queryClient.invalidateQueries({ queryKey: ['artifact', artifactId] });
      queryClient.invalidateQueries({ queryKey: ['artifactVersions', artifactId] });
    };

    window.addEventListener(ARTIFACT_VERSION_CREATED_EVENT, onVersionCreated);
    return () => window.removeEventListener(ARTIFACT_VERSION_CREATED_EVENT, onVersionCreated);
  }, [queryClient]);
}

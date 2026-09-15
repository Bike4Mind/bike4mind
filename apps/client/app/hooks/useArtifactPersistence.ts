import { useState, useEffect } from 'react';
import { checkArtifactExists } from '@client/app/utils/artifactPersistence';

/**
 * Hook to check if an artifact exists in the database
 */
export function useArtifactPersistence(artifactId: string | null): {
  isPersisted: boolean | null;
  isLoading: boolean;
} {
  const [isPersisted, setIsPersisted] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!artifactId) {
      setIsPersisted(null);
      setIsLoading(false);
      return;
    }

    let isCancelled = false;

    const checkPersistence = async () => {
      setIsLoading(true);
      try {
        const exists = await checkArtifactExists(artifactId);
        if (!isCancelled) {
          setIsPersisted(exists);
          setIsLoading(false);
        }
      } catch (error) {
        console.warn('Failed to check artifact persistence:', error);
        if (!isCancelled) {
          setIsPersisted(false);
          setIsLoading(false);
        }
      }
    };

    checkPersistence();

    return () => {
      isCancelled = true;
    };
  }, [artifactId]);

  return { isPersisted, isLoading };
}

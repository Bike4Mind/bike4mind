import { useMemo } from 'react';
import { useWorkBenchFiles, useSystemPromptFiles } from '@client/app/contexts/SessionsContext';
import { useEffectiveEmbeddingModel } from '@client/app/hooks/data/settings';
import { IFabFileDocument } from '@bike4mind/common';

/**
 * Hook to determine if there are any files with embedding model mismatches - i.e. files whose vectors
 * live in a different space than the one this deployment would query with, so search cannot reach them.
 *
 * Compares against the EFFECTIVE model (see useEffectiveEmbeddingModel), never the advertised
 * `defaultEmbeddingModel` setting: on a stage that fell back to the keyless embedder the corpus is
 * stamped with the model it fell back TO, and comparing against the advertised one reddens the file
 * count for a whole library of healthy files whose reprocess button would only re-stamp the same
 * label. While the effective model is unknown, reports no mismatch rather than a guessed one.
 */
export const useEmbeddingMismatchStatus = (sessionId?: string | null) => {
  const workBenchFiles = useWorkBenchFiles(sessionId);
  const { systemFiles } = useSystemPromptFiles();
  const effectiveEmbeddingModel = useEffectiveEmbeddingModel();

  const hasEmbeddingMismatches = useMemo(() => {
    if (!effectiveEmbeddingModel) return false;

    const allFiles = [...workBenchFiles, ...systemFiles];
    return allFiles.some((file: IFabFileDocument) => {
      return file.embeddingModel && effectiveEmbeddingModel !== file.embeddingModel;
    });
  }, [workBenchFiles, systemFiles, effectiveEmbeddingModel]);

  return hasEmbeddingMismatches;
};

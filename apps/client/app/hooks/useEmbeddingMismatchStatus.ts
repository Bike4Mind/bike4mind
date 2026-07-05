import { useMemo } from 'react';
import { useWorkBenchFiles, useSystemPromptFiles } from '@client/app/contexts/SessionsContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { IFabFileDocument } from '@bike4mind/common';

/**
 * Hook to determine if there are any files with embedding model mismatches
 * Returns true if any workbench files or system files have different embedding models than the current default
 */
export const useEmbeddingMismatchStatus = (sessionId?: string | null) => {
  const workBenchFiles = useWorkBenchFiles(sessionId);
  const { systemFiles } = useSystemPromptFiles();
  const currentEmbeddingModel = useGetSettingsValue('defaultEmbeddingModel');

  const hasEmbeddingMismatches = useMemo(() => {
    if (!currentEmbeddingModel) return false;

    const allFiles = [...workBenchFiles, ...systemFiles];
    return allFiles.some((file: IFabFileDocument) => {
      return file.embeddingModel && String(currentEmbeddingModel) !== file.embeddingModel;
    });
  }, [workBenchFiles, systemFiles, currentEmbeddingModel]);

  return hasEmbeddingMismatches;
};

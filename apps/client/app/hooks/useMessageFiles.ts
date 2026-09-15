import { useMemo } from 'react';
import type { IFabFileDocument } from '@bike4mind/common';
import { useGetFabFilesBySessionId } from '@client/app/hooks/data/fabFiles';
import { useWorkBenchFiles, useSystemPromptFiles } from '@client/app/contexts/SessionsContext';

/**
 * Custom hook to fetch and filter message files for a session
 *
 * Message files are files attached to individual messages (not session-level workbench files
 * or system-level prompt files). This hook fetches all files for a session and filters out
 * workbench and system files.
 *
 * @param sessionId - The session ID to fetch files for (can be null or undefined)
 * @returns Array of message files (files attached to individual messages)
 */
export function useMessageFiles(sessionId: string | null | undefined): IFabFileDocument[] {
  // Fetch all files from session (includes session files, message files, and system files)
  const { data: allSessionFiles = [] } = useGetFabFilesBySessionId(sessionId || '', {
    enabled: !!sessionId,
  });

  // Get workbench files and system files
  const workBenchFiles = useWorkBenchFiles(sessionId || undefined);
  const { systemFiles } = useSystemPromptFiles();

  // Filter out workbench and system files to get only message files
  return useMemo(() => {
    const workBenchFileIds = new Set(workBenchFiles.map((f: IFabFileDocument) => f.id));
    const systemFileIds = new Set(systemFiles.map((f: IFabFileDocument) => f.id));
    return allSessionFiles.filter(
      (file: IFabFileDocument) => !workBenchFileIds.has(file.id) && !systemFileIds.has(file.id)
    );
  }, [allSessionFiles, workBenchFiles, systemFiles]);
}

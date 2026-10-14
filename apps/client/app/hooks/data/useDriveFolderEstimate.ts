import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';

/** Response of POST /api/google-drive/estimate-folder (server: estimateFolder in driveContent). */
export type DriveFolderEstimate = {
  folderId: string;
  fileCount: number;
  /** Bytes of the files the sync would import. A floor: unknown-size files add more. */
  knownBytes: number;
  unknownSizeCount: number;
  overSizeLimitCount: number;
  unsupportedCount: number;
  /** The walk stopped early, so every count is a lower bound. */
  truncated: boolean;
  truncatedReason?: 'deadline' | 'folder_cap' | 'rate_limited' | 'candidate_cap';
  /** More files than one sync accepts; the sync refuses the whole folder. */
  overCandidateCap: boolean;
  maxFileSizeBytes: number;
  candidateCap: number;
};

// Google's files.export caps exported content at 10 MB; MiB here keeps the bound conservative.
export const DRIVE_EXPORT_CAP_BYTES = 10 * 1024 * 1024;

/** Upper bound on what the folder could debit, treating every unknown-size file as its largest possible size. */
export function driveWorstCaseBytes(e: DriveFolderEstimate): number {
  return e.knownBytes + e.unknownSizeCount * Math.min(DRIVE_EXPORT_CAP_BYTES, e.maxFileSizeBytes);
}

/**
 * Pre-flight size estimate of a picked Drive folder for the Create Data Lake wizard. The walk can
 * take up to ~20s, so it is cached across step navigation and never retried automatically.
 */
export function useDriveFolderEstimate(driveFolderId?: string) {
  return useQuery({
    queryKey: ['google-drive', 'estimate-folder', driveFolderId],
    queryFn: async () => {
      const response = await api.post<DriveFolderEstimate>('/api/google-drive/estimate-folder', {
        folderId: driveFolderId,
      });
      return response.data;
    },
    enabled: !!driveFolderId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

import { api } from '@client/app/contexts/ApiContext';
import { useQuery } from '@tanstack/react-query';
import type { DriveFolderEstimate as ServerDriveFolderEstimate } from '@server/integrations/google/drive/driveContent';
import { checkStorageForUpload, type StorageQuota } from '@client/app/utils/storageQuota';

/** Response of POST /api/google-drive/estimate-folder. */
export type DriveFolderEstimate = ServerDriveFolderEstimate & {
  folderId: string;
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
 * The wizard's Drive commit decision, shared by DataLakeWizardModal (which blocks on it) and
 * DriveFolderEstimateSummary (which explains it), so the two cannot disagree.
 *
 * Known bytes are a floor even on a truncated estimate, so they can always block; a pending or
 * failed estimate counts as 0 and never locks the user out - the sync stays the boundary. Only a
 * commit that carries bytes is judged, so a user already over quota is not blocked by one that
 * sends none. The worst case only warns, and only on a complete estimate.
 */
export function driveCommitGate(quota: StorageQuota | null, uploadBytes: number, estimate?: DriveFolderEstimate) {
  const driveKnownBytes = estimate?.knownBytes ?? 0;
  const commitBytes = uploadBytes + driveKnownBytes;
  const exceedsStorage = commitBytes > 0 && checkStorageForUpload(quota, commitBytes).status === 'exceeds';
  const worstCaseExceeds =
    !!estimate &&
    !estimate.truncated &&
    estimate.unknownSizeCount > 0 &&
    !exceedsStorage &&
    checkStorageForUpload(quota, uploadBytes + driveWorstCaseBytes(estimate)).status === 'exceeds';
  return {
    driveKnownBytes,
    commitBytes,
    exceedsStorage,
    // The sync refuses the whole folder past its file cap, so creating would leave an empty lake.
    overCandidateCap: !!estimate?.overCandidateCap,
    worstCaseExceeds,
  };
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

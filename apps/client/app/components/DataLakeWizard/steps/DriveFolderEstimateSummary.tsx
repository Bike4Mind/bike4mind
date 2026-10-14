import { Alert, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useUser } from '@client/app/contexts/UserContext';
import { plannedUploadBytes } from '@client/app/hooks/data/dataLakeUploadPipeline';
import { driveWorstCaseBytes, useDriveFolderEstimate } from '@client/app/hooks/data/useDriveFolderEstimate';
import { checkStorageForUpload, getStorageQuota } from '@client/app/utils/storageQuota';

/**
 * What the picked Drive folder will bring in, on the Configure summary. The blocking decisions
 * (known bytes over quota, over the file cap) live in DataLakeWizardModal; this only shows them,
 * plus the non-blocking warning when unknown-size files could push the commit over.
 */
export default function DriveFolderEstimateSummary({ driveFolderId }: { driveFolderId: string }) {
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const conflictResolution = useDataLakeWizardStore(s => s.config.conflictResolution);
  const currentUser = useUser(s => s.currentUser);
  const { data: estimate, isLoading, isError } = useDriveFolderEstimate(driveFolderId);

  if (isLoading) {
    return (
      <Typography level="body-sm" color="neutral" data-testid="drive-estimate-loading">
        Estimating Drive folder...
      </Typography>
    );
  }

  if (estimate?.overCandidateCap) {
    return (
      <Alert color="danger" variant="soft" data-testid="drive-estimate-over-cap">
        This Drive folder has more than {estimate.candidateCap.toLocaleString()} files, over the limit for one sync.
        Split it into subfolders and connect them separately.
      </Alert>
    );
  }

  if (isError || !estimate || estimate.truncated) {
    return (
      <Typography level="body-sm" color="neutral" data-testid="drive-estimate-unavailable">
        This Drive folder is too large to estimate quickly, or could not be estimated; the sync still enforces your
        storage limit.
      </Typography>
    );
  }

  const skipped = [
    estimate.overSizeLimitCount > 0 && `${estimate.overSizeLimitCount.toLocaleString()} over the per-file size limit`,
    estimate.unsupportedCount > 0 && `${estimate.unsupportedCount.toLocaleString()} of unsupported types`,
  ].filter(Boolean);
  const quota = getStorageQuota(currentUser);
  const uploadBytes = plannedUploadBytes(allFiles, conflictResolution);
  const worstCaseExceeds =
    checkStorageForUpload(quota, uploadBytes + estimate.knownBytes).status !== 'exceeds' &&
    checkStorageForUpload(quota, uploadBytes + driveWorstCaseBytes(estimate)).status === 'exceeds';

  return (
    <>
      <Typography level="body-sm" data-testid="drive-estimate-summary">
        Drive folder: <strong>{estimate.fileCount.toLocaleString()}</strong> files, at least{' '}
        <strong>{prettyBytes(estimate.knownBytes)}</strong>
        {estimate.unknownSizeCount > 0 &&
          ` (plus ${estimate.unknownSizeCount.toLocaleString()} Google files of unknown size)`}
      </Typography>
      {skipped.length > 0 && (
        <Typography level="body-xs" color="neutral" data-testid="drive-estimate-skipped">
          Not imported: {skipped.join(', ')}.
        </Typography>
      )}
      {worstCaseExceeds && (
        <Alert color="warning" variant="soft" data-testid="drive-estimate-worst-case-warning">
          The files of unknown size could push this past your storage limit. The sync skips files once the limit is
          reached.
        </Alert>
      )}
    </>
  );
}

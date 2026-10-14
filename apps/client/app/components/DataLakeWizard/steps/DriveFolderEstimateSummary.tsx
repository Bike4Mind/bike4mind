import { Alert, Typography } from '@mui/joy';
import prettyBytes from 'pretty-bytes';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useUser } from '@client/app/contexts/UserContext';
import { plannedUploadBytes } from '@client/app/hooks/data/dataLakeUploadPipeline';
import { driveCommitGate, useDriveFolderEstimate } from '@client/app/hooks/data/useDriveFolderEstimate';
import { getStorageQuota } from '@client/app/utils/storageQuota';

/**
 * What the picked Drive folder will bring in, on the Configure summary. The blocking decisions
 * (known bytes over quota, over the file cap) are DataLakeWizardModal's, through the same
 * driveCommitGate; this only shows them, plus the non-blocking worst-case warning.
 */
export default function DriveFolderEstimateSummary({ driveFolderId }: { driveFolderId: string }) {
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const conflictResolution = useDataLakeWizardStore(s => s.config.conflictResolution);
  const currentUser = useUser(s => s.currentUser);
  const { data: estimate, isLoading, isError } = useDriveFolderEstimate(driveFolderId);
  const gate = driveCommitGate(
    getStorageQuota(currentUser),
    plannedUploadBytes(allFiles, conflictResolution),
    estimate
  );

  if (isLoading) {
    return (
      <Typography level="body-sm" color="neutral" data-testid="drive-estimate-loading">
        Estimating Drive folder...
      </Typography>
    );
  }

  if (gate.overCandidateCap && estimate) {
    return (
      <Alert color="danger" variant="soft" data-testid="drive-estimate-over-cap">
        This Drive folder has more than {estimate.candidateCap.toLocaleString()} files, over the limit for one sync.
        Split it into subfolders and connect them separately.
      </Alert>
    );
  }

  // A truncated walk whose partial DRIVE bytes already exceed the quota still blocks in the modal,
  // so its partial counts are shown (as lower bounds) rather than "could not be estimated". Keyed on
  // the Drive bytes, not the whole commit: local files alone can put it over with nothing to report.
  if (isError || !estimate || (estimate.truncated && !(estimate.knownBytes > 0 && gate.exceedsStorage))) {
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
  return (
    <>
      <Typography level="body-sm" data-testid="drive-estimate-summary">
        Drive folder: {estimate.truncated && 'at least '}
        <strong>{estimate.fileCount.toLocaleString()}</strong> files, at least{' '}
        <strong>{prettyBytes(estimate.knownBytes)}</strong>
        {estimate.unknownSizeCount > 0 &&
          ` (plus ${estimate.unknownSizeCount.toLocaleString()} Google files of unknown size)`}
      </Typography>
      {skipped.length > 0 && (
        <Typography level="body-xs" color="neutral" data-testid="drive-estimate-skipped">
          Not imported: {skipped.join(', ')}.
        </Typography>
      )}
      {gate.worstCaseExceeds && (
        <Alert color="warning" variant="soft" data-testid="drive-estimate-worst-case-warning">
          The files of unknown size could push this past your storage limit. The sync skips files once the limit is
          reached.
        </Alert>
      )}
    </>
  );
}

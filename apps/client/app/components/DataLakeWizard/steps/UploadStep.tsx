import { Alert, Box, Button, Chip, CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useDataLakeWizardStore, type UploadProgress } from '@client/app/stores/useDataLakeWizardStore';
import { DATA_LAKE, DATA_LAKES } from '@client/app/components/datalake/dataLakeBranding';
import { useBatchProgressListener } from '@client/app/hooks/data/dataLakeWizard';

/**
 * Background AI-tag suggestion status, shown only while the wizard's Complete screen
 * is still open - closing it (or clicking Done) stops watching; from then on the Data Lakes
 * list is the source of truth, via the same taxonomyStatus polled there. `undefined` (no
 * WebSocket message yet, right after upload) reads the same as 'queued'/'analyzing': the job
 * was requested but hasn't reported in yet.
 */
function TaxonomyStatusRow({ status }: { status: string | undefined }) {
  if (status === 'ready') {
    return (
      <Chip size="sm" variant="soft" color="success" startDecorator={<AutoAwesomeIcon sx={{ fontSize: 14 }} />}>
        Tags ready - review from the Data Lakes list
      </Chip>
    );
  }
  if (status === 'failed') {
    return (
      <Typography level="body-xs" color="neutral">
        AI tagging didn&apos;t complete - files still have their folder tags.
      </Typography>
    );
  }
  // undefined | 'none' | 'queued' | 'analyzing' | 'applying' | 'applied'
  return (
    <Chip
      size="sm"
      variant="soft"
      color="neutral"
      startDecorator={<CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />}
    >
      Suggesting tags with AI&hellip;
    </Chip>
  );
}

/**
 * Splits the batch's total failedFiles into its two possible causes and phrases each in its own
 * terms, rather than a bare "N file(s) failed" that reads as an upload failure either way
 * (#1412) - `failedFiles` is the total the batch counters agree on; `processingFailedFiles` is
 * server-reported and always a subset of it, so upload-only failures are the remainder.
 */
function describeFailures(failedFiles: number, processingFailedFiles: number): string {
  // Clamp: today's write paths keep 0 <= processingFailedFiles <= failedFiles (both counters
  // move together in one atomic increment - see incrementCounters), but clamping here means a
  // future regression could never display more processing failures than the batch's real total.
  const safeProcessingFailed = Math.min(Math.max(processingFailedFiles, 0), failedFiles);
  const uploadFailed = failedFiles - safeProcessingFailed;
  const parts: string[] = [];
  if (uploadFailed > 0) {
    parts.push(`${uploadFailed.toLocaleString()} ${uploadFailed === 1 ? 'file' : 'files'} failed to upload`);
  }
  if (safeProcessingFailed > 0) {
    parts.push(
      `${safeProcessingFailed.toLocaleString()} ${safeProcessingFailed === 1 ? 'file' : 'files'} failed to process`
    );
  }
  return parts.join('; ');
}

/**
 * The fileless Drive commit's own status screen (#1916): create the lake, bind the folder, hand off
 * to background ingest. No per-file counters exist on this path - the files arrive later, from
 * Drive - so it reports the connection instead of a progress bar it could only ever draw at 0%.
 */
function DriveOnlyCommitStatus({
  status,
  errorMessage,
  driveRollback,
  folderLabel,
  onDone,
  onBack,
}: {
  status: UploadProgress['status'];
  errorMessage: string | undefined;
  driveRollback: UploadProgress['driveRollback'];
  folderLabel: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const centered = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  } as const;

  // Whole sentences, not JSX text interleaved with {DATA_LAKE} expressions: JSX drops the space
  // between an expression and the text that follows it, which shipped a live "Data Lakeslist".
  // One string per sentence also keeps the copy greppable. Curly quotes as escapes per CLAUDE.md.
  const quoted = `\u201c${folderLabel}\u201d`;
  const syncingSentence =
    `Google Drive ingest is running in the background for ${quoted}. ` +
    `Files appear in this ${DATA_LAKE} as they are pulled in - the ${DATA_LAKES} list shows the connection's status.`;
  const idleSentence = `Ready to create this ${DATA_LAKE} and sync ${quoted}.`;
  const rollbackFailedSentence =
    `The empty ${DATA_LAKE} could not be cleaned up, so it may still be in your ${DATA_LAKES} list. ` +
    `Check the list and delete it before trying again, or contact support if it will not go away.`;

  if (status === 'complete') {
    return (
      <Box sx={centered} data-testid="drive-only-commit-complete">
        <CheckCircleIcon sx={{ fontSize: 64, color: 'success.500' }} />
        <Typography level="title-lg">{DATA_LAKE} Created</Typography>
        <Typography level="body-sm" color="neutral" textAlign="center" sx={{ maxWidth: 420 }}>
          {syncingSentence}
        </Typography>
        <Button variant="solid" color="primary" onClick={onDone}>
          Done
        </Button>
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Box sx={centered} data-testid="drive-only-commit-error">
        <ErrorOutlineIcon sx={{ fontSize: 64, color: 'danger.500' }} />
        <Typography level="title-lg" color="danger">
          Could not connect Google Drive
        </Typography>
        <Typography level="body-sm" color="neutral" textAlign="center" sx={{ maxWidth: 420 }}>
          {errorMessage || 'The Google Drive folder could not be connected. Please try again.'}
        </Typography>
        {/* Say only what the rollback actually did. 'archived' is the reason this can be retried
            from Configure with no cleanup; 'failed' means the archive call itself failed, so the
            empty lake is still live and a blind retry would add a second one next to it. Anything
            else (no rollback attempted, e.g. the create never succeeded) claims nothing. */}
        {driveRollback === 'archived' && (
          <Typography level="body-xs" color="neutral" textAlign="center" sx={{ maxWidth: 420 }}>
            The new {DATA_LAKE} was rolled back - nothing was added to your list.
          </Typography>
        )}
        {driveRollback === 'failed' && (
          <Typography level="body-xs" color="warning" textAlign="center" sx={{ maxWidth: 420 }}>
            {rollbackFailedSentence}
          </Typography>
        )}
        <Button variant="outlined" color="neutral" onClick={onBack}>
          Back to Configuration
        </Button>
      </Box>
    );
  }

  if (status === 'uploading') {
    return (
      <Box sx={centered} data-testid="drive-only-commit-pending">
        <CircularProgress size="lg" />
        <Typography level="title-md">Creating the {DATA_LAKE} and connecting Google Drive&hellip;</Typography>
      </Box>
    );
  }

  return (
    <Box sx={centered} data-testid="drive-only-commit-idle">
      <Typography level="title-md" color="neutral">
        {idleSentence}
      </Typography>
    </Box>
  );
}

function ProgressRow({ label, current, total }: { label: string; current: number; total: number }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.25 }}>
        <Typography level="body-xs">{label}</Typography>
        <Typography level="body-xs">
          {current.toLocaleString()} / {total.toLocaleString()} ({pct}%)
        </Typography>
      </Stack>
      <LinearProgress determinate value={pct} sx={{ height: 6, borderRadius: 3 }} />
    </Box>
  );
}

export default function UploadStep() {
  const progress = useDataLakeWizardStore(s => s.uploadProgress);
  const closeWizard = useDataLakeWizardStore(s => s.closeWizard);
  const resetWizard = useDataLakeWizardStore(s => s.resetWizard);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  // Append mode locks the Config fields to the existing lake, so a "fix your Name /
  // Tag Prefix" hint would point at inputs the user can't edit.
  const isAppendMode = useDataLakeWizardStore(s => s.targetLake !== null);
  const pendingDriveFolder = useDataLakeWizardStore(s => s.pendingDriveFolder);
  // The fileless Drive commit (#1916) shares uploadProgress with the upload path, so it is told
  // apart by having a Drive folder and no files at all - the one shape the upload path can't
  // produce (it refuses an empty batch). Everything below then reads in Drive terms instead of
  // file counts, which would all be zero and read as a failure.
  const isDriveOnlyCommit = !!pendingDriveFolder && progress.totalFiles === 0;
  const driveFolderLabel = pendingDriveFolder?.folderName || 'your Drive folder';
  // AI tagging is never offered in append mode (the source step hides the toggle there too).
  const wantsTaxonomy = useDataLakeWizardStore(s => s.optionalSteps.taxonomy) && !isAppendMode;

  // Subscribe to real-time chunk/vectorize progress from WebSocket
  useBatchProgressListener();

  const isComplete = progress.status === 'complete';
  const isError = progress.status === 'error';
  const isUploading = progress.status === 'uploading';
  const isIdle = progress.status === 'idle';

  if (isDriveOnlyCommit) {
    return (
      <Box data-testid="wizard-upload-step" sx={{ flex: 1, display: 'flex', flexDirection: 'column', p: 3 }}>
        <DriveOnlyCommitStatus
          status={progress.status}
          errorMessage={progress.errorMessage}
          driveRollback={progress.driveRollback}
          folderLabel={driveFolderLabel}
          onDone={resetWizard}
          onBack={() => setStep('config')}
        />
      </Box>
    );
  }

  // Uploads finish before chunk/vectorize (async, and skipped entirely in
  // self-host without the worker - see #822/#828). Drive the completion copy
  // from the real counts so we never claim work that hasn't happened. The
  // WebSocket listener keeps these counts flowing after status flips to
  // 'complete', so this line updates live as processing catches up.
  const { uploadedFiles, chunkedFiles, vectorizedFiles } = progress;
  const fileWord = uploadedFiles === 1 ? 'file' : 'files';
  const fullyProcessed = uploadedFiles > 0 && chunkedFiles >= uploadedFiles && vectorizedFiles >= uploadedFiles;
  const processingStarted = chunkedFiles > 0 || vectorizedFiles > 0;
  let completionSummary: string;
  if (fullyProcessed) {
    completionSummary = `${uploadedFiles.toLocaleString()} ${fileWord} uploaded, chunked, and vectorized.`;
  } else if (processingStarted) {
    completionSummary = `${uploadedFiles.toLocaleString()} ${fileWord} uploaded - ${chunkedFiles.toLocaleString()} chunked, ${vectorizedFiles.toLocaleString()} vectorized so far.`;
  } else {
    completionSummary = `${uploadedFiles.toLocaleString()} ${fileWord} uploaded - chunking and vectorizing in progress.`;
  }
  if (progress.failedFiles > 0) {
    completionSummary += ` ${describeFailures(progress.failedFiles, progress.processingFailedFiles)}.`;
  }

  return (
    <Box data-testid="wizard-upload-step" sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2.5, p: 3 }}>
      {/* Idle state — waiting to start */}
      {isIdle && (
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Typography level="title-md" color="neutral">
            Ready to start upload. Click &quot;Start Upload&quot; below.
          </Typography>
        </Box>
      )}

      {/* Upload in progress */}
      {isUploading && (
        <>
          <Typography level="title-md">Uploading files...</Typography>

          <Stack gap={1.5}>
            <ProgressRow label="Uploaded" current={progress.uploadedFiles} total={progress.totalFiles} />
            <ProgressRow label="Chunked" current={progress.chunkedFiles} total={progress.totalFiles} />
            <ProgressRow label="Vectorized" current={progress.vectorizedFiles} total={progress.totalFiles} />
          </Stack>

          {progress.failedFiles > 0 && (
            <Alert color="warning" startDecorator={<ErrorOutlineIcon />}>
              {describeFailures(progress.failedFiles, progress.processingFailedFiles)}
              {/* failedFileNames only ever names browser-upload failures - the pipeline never
                  writes it - so it belongs under that half of the count, not the total. */}
              {progress.failedFileNames.length > 0 && (
                <Typography level="body-xs" sx={{ mt: 0.5 }}>
                  {progress.failedFileNames.slice(0, 5).join(', ')}
                  {progress.failedFileNames.length > 5 && ` and ${progress.failedFileNames.length - 5} more`}
                </Typography>
              )}
            </Alert>
          )}

          <Button variant="outlined" color="neutral" onClick={closeWizard}>
            Close and continue in background
          </Button>
        </>
      )}

      {/* Complete */}
      {isComplete && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
          }}
        >
          <CheckCircleIcon sx={{ fontSize: 64, color: 'success.500' }} />
          <Typography level="title-lg">Upload Complete!</Typography>
          <Typography level="body-sm" color="neutral" textAlign="center">
            {completionSummary}
          </Typography>
          {wantsTaxonomy && <TaxonomyStatusRow status={progress.taxonomyStatus} />}
          <Button variant="solid" color="primary" onClick={resetWizard}>
            Done
          </Button>
        </Box>
      )}

      {/* Error */}
      {isError && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
          }}
        >
          <ErrorOutlineIcon sx={{ fontSize: 64, color: 'danger.500' }} />
          <Typography level="title-lg" color="danger">
            Upload Failed
          </Typography>
          <Typography level="body-sm" color="neutral" textAlign="center" sx={{ maxWidth: 400 }}>
            {progress.errorMessage || `${progress.failedFiles} of ${progress.totalFiles} files failed to upload.`}
          </Typography>
          {/* Hint matches the failure kind: only a validation failure is actually about the
              Name/Tag Prefix fields, so don't send network/upload failures back there. */}
          {progress.errorKind === 'validation' && !isAppendMode && (
            <Alert color="warning" variant="soft" sx={{ maxWidth: 400, textAlign: 'left' }}>
              <Typography level="body-xs">
                <strong>Common fixes:</strong> The {DATA_LAKE} Name needs at least 2 letters or numbers, and the Tag
                Prefix must end with &quot;:&quot; (e.g. &quot;legal:&quot;).
              </Typography>
            </Alert>
          )}
          {(progress.errorKind === 'network' || progress.errorKind === 'upload') && (
            <Alert color="warning" variant="soft" sx={{ maxWidth: 400, textAlign: 'left' }}>
              <Typography level="body-xs">
                <strong>Common fixes:</strong> Check your internet connection and try again. Your {DATA_LAKE} settings
                are not the problem.
              </Typography>
            </Alert>
          )}
          <Button variant="outlined" color="neutral" onClick={() => setStep('config')}>
            Back to Configuration
          </Button>
        </Box>
      )}
    </Box>
  );
}

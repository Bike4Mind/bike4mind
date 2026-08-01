import { Alert, Box, Button, Chip, CircularProgress, LinearProgress, Stack, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
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
  // Append mode locks the Config fields to the existing lake, so a "fix your Name /
  // Tag Prefix" hint would point at inputs the user can't edit.
  const isAppendMode = useDataLakeWizardStore(s => s.targetLake !== null);
  // AI tagging is never offered in append mode (the source step hides the toggle there too).
  const wantsTaxonomy = useDataLakeWizardStore(s => s.optionalSteps.taxonomy) && !isAppendMode;

  // Subscribe to real-time chunk/vectorize progress from WebSocket
  useBatchProgressListener();

  const isComplete = progress.status === 'complete';
  const isError = progress.status === 'error';
  const isUploading = progress.status === 'uploading';
  const isIdle = progress.status === 'idle';

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
    const failedWord = progress.failedFiles === 1 ? 'file' : 'files';
    completionSummary += ` ${progress.failedFiles.toLocaleString()} ${failedWord} failed.`;
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
              {progress.failedFiles} file{progress.failedFiles !== 1 ? 's' : ''} failed
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
          <Button
            variant="outlined"
            color="neutral"
            onClick={() => {
              const setStep = useDataLakeWizardStore.getState().setStep;
              setStep('config');
            }}
          >
            Back to Configuration
          </Button>
        </Box>
      )}
    </Box>
  );
}

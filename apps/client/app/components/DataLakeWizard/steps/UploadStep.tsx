import { Alert, Box, Button, LinearProgress, Stack, Typography } from '@mui/joy';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useBatchProgressListener } from '@client/app/hooks/data/dataLakeWizard';

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

  // Subscribe to real-time chunk/vectorize progress from WebSocket
  useBatchProgressListener();

  const isComplete = progress.status === 'complete';
  const isError = progress.status === 'error';
  const isUploading = progress.status === 'uploading';
  const isIdle = progress.status === 'idle';

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
            {progress.uploadedFiles.toLocaleString()} files uploaded, chunked, and vectorized.
            {progress.failedFiles > 0 && ` ${progress.failedFiles} failed.`}
          </Typography>
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
          <Alert color="warning" variant="soft" sx={{ maxWidth: 400, textAlign: 'left' }}>
            <Typography level="body-xs">
              <strong>Common fixes:</strong> Make sure the {DATA_LAKE} Name and Tag Prefix fields are filled in. The Tag
              Prefix must end with &quot;:&quot; (e.g. &quot;legal:&quot;).
            </Typography>
          </Alert>
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

import { Box, CircularProgress, IconButton, Stack, Typography } from '@mui/joy';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';

/**
 * Floating indicator that shows data lake upload progress
 * when the wizard modal is closed but an upload is in progress.
 */
export default function DataLakeUploadIndicator() {
  const isOpen = useDataLakeWizardStore(s => s.isOpen);
  const progress = useDataLakeWizardStore(s => s.uploadProgress);
  const openWizard = useDataLakeWizardStore(s => s.openWizard);
  const setStep = useDataLakeWizardStore(s => s.setStep);

  // Only show when wizard is closed and upload is active or just finished
  const shouldShow = !isOpen && progress.status !== 'idle' && progress.totalFiles > 0;
  if (!shouldShow) return null;

  const pct = progress.totalFiles > 0 ? Math.round((progress.uploadedFiles / progress.totalFiles) * 100) : 0;

  const handleClick = () => {
    openWizard();
    setStep('upload');
  };

  return (
    <Box
      data-testid="data-lake-upload-indicator"
      onClick={handleClick}
      sx={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 1100,
        cursor: 'pointer',
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'lg',
        boxShadow: 'lg',
        px: 2,
        py: 1.5,
        minWidth: 200,
        '&:hover': { boxShadow: 'xl' },
      }}
    >
      <Stack direction="row" alignItems="center" gap={1.5}>
        {progress.status === 'uploading' && <CircularProgress size="sm" value={pct} determinate />}
        {progress.status === 'complete' && <CheckCircleIcon sx={{ color: 'success.500', fontSize: 24 }} />}
        {progress.status === 'error' && <ErrorOutlineIcon sx={{ color: 'danger.500', fontSize: 24 }} />}

        <Box sx={{ flex: 1 }}>
          <Typography level="body-xs" fontWeight="lg">
            {progress.status === 'uploading' && `Uploading... ${pct}%`}
            {progress.status === 'complete' && 'Upload Complete'}
            {progress.status === 'error' && 'Upload Failed'}
          </Typography>
          <Typography level="body-xs" color="neutral">
            {progress.uploadedFiles} / {progress.totalFiles} files
          </Typography>
        </Box>

        <IconButton size="sm" variant="plain" color="neutral">
          <CloudUploadIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Box>
  );
}

import { Box, Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
import { useDataLakeWizardStore, type WizardStep } from '@client/app/stores/useDataLakeWizardStore';
import { useBatchUpload } from '@client/app/hooks/data/dataLakeWizard';
import WizardStepIndicator from './WizardStepIndicator';
import SourceSelectionStep from './steps/SourceSelectionStep';
import PreviewStep from './steps/PreviewStep';
import TaxonomyReviewStep from './steps/TaxonomyReviewStep';
import ConfigStep from './steps/ConfigStep';
import UploadStep from './steps/UploadStep';

const CREATE_STEPS: WizardStep[] = ['source', 'preview', 'taxonomy', 'config', 'upload'];
// Append mode reuses the existing lake's tags, so AI taxonomy is skipped.
const APPEND_STEPS: WizardStep[] = ['source', 'preview', 'config', 'upload'];

export default function DataLakeWizardModal() {
  const theme = useTheme();
  const isOpen = useDataLakeWizardStore(s => s.isOpen);
  const step = useDataLakeWizardStore(s => s.step);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  const resetWizard = useDataLakeWizardStore(s => s.resetWizard);
  const updateUploadProgress = useDataLakeWizardStore(s => s.updateUploadProgress);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const taxonomy = useDataLakeWizardStore(s => s.taxonomy);
  const config = useDataLakeWizardStore(s => s.config);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);

  const batchUpload = useBatchUpload();

  const STEP_ORDER = targetLake ? APPEND_STEPS : CREATE_STEPS;
  const currentIndex = STEP_ORDER.indexOf(step);

  const canGoBack = currentIndex > 0 && step !== 'upload';

  const canGoNext = (() => {
    switch (step) {
      case 'source':
        return allFiles.length > 0;
      case 'preview':
        return allFiles.some(f => !f.excluded);
      case 'taxonomy':
        return taxonomy.analyzed;
      case 'config':
        return config.name.trim().length > 0 && config.tagPrefix.trim().length >= 2;
      case 'upload':
        return false; // No "next" on last step
    }
  })();

  const handleBack = () => {
    if (canGoBack) {
      setStep(STEP_ORDER[currentIndex - 1]);
    }
  };

  const handleNext = () => {
    if (canGoNext && currentIndex < STEP_ORDER.length - 1) {
      setStep(STEP_ORDER[currentIndex + 1]);
    }
  };

  const handleClose = () => {
    if (allFiles.length > 0 && step !== 'source') {
      // Confirm close if files are loaded
      if (!window.confirm('You have unsaved progress. Are you sure you want to close the wizard?')) {
        return;
      }
    }
    resetWizard();
  };

  const handleStartUpload = () => {
    // Belt-and-suspenders with the same check inside useBatchUpload's mutationFn:
    // checking here means the button never even flips into its loading state for
    // the common "already offline" case, instead of depending on the mutation
    // lifecycle to notice and unwind.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const message = 'No internet connection — check your network and try again.';
      // Mirror useBatchUpload's onError so uploadProgress reflects this failure
      // the same way regardless of which of the two entry points caught it, and
      // reuse its toast id so a repeated offline click/retry replaces the same
      // toast instead of stacking a new one.
      updateUploadProgress({ status: 'error', errorMessage: message });
      toast.error(message, {
        id: 'data-lake-batch-upload-error',
        duration: 8000,
        action: { label: 'Retry', onClick: handleStartUpload },
      });
      return;
    }
    batchUpload.mutate();
  };

  const renderStep = () => {
    switch (step) {
      case 'source':
        return <SourceSelectionStep />;
      case 'preview':
        return <PreviewStep />;
      case 'taxonomy':
        return <TaxonomyReviewStep />;
      case 'config':
        return <ConfigStep />;
      case 'upload':
        return <UploadStep />;
    }
  };

  return (
    <Modal open={isOpen} onClose={handleClose}>
      <ModalDialog
        data-testid="data-lake-wizard-modal"
        sx={{
          width: { xs: '95%', sm: '90%', md: '80%', lg: '64rem' },
          maxWidth: '64rem',
          minHeight: '70vh',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          p: 0,
          overflow: 'hidden',
          bgcolor: theme.palette.background.body,
        }}
      >
        <ModalClose onClick={handleClose} />

        {/* Header */}
        <Box sx={{ px: 3, pt: 2.5, pb: 0 }}>
          <Typography level="h4" fontWeight="lg">
            {targetLake ? `Add Files — ${targetLake.name}` : 'Create Data Lake'}
          </Typography>
        </Box>

        {/* Step indicator */}
        <WizardStepIndicator currentStep={step} stepKeys={STEP_ORDER} />

        {/* Step content */}
        <Box sx={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>{renderStep()}</Box>

        {/* Footer */}
        <Stack
          direction="row"
          justifyContent="space-between"
          sx={{
            px: 3,
            py: 2,
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          <Button variant="plain" color="neutral" onClick={handleClose}>
            Cancel
          </Button>
          <Stack direction="row" gap={1}>
            {canGoBack && (
              <Button variant="outlined" color="neutral" onClick={handleBack}>
                Back
              </Button>
            )}
            {step === 'config' ? (
              <Button
                data-testid="wizard-start-upload-btn"
                variant="solid"
                color="success"
                disabled={!canGoNext || batchUpload.isPending}
                loading={batchUpload.isPending}
                onClick={handleStartUpload}
              >
                Start Upload
              </Button>
            ) : step !== 'upload' ? (
              <Button
                data-testid="wizard-next-btn"
                variant="solid"
                color="primary"
                disabled={!canGoNext}
                onClick={handleNext}
              >
                Next
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

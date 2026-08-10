import { Box, Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
import { useDataLakeWizardStore, type OptionalSteps } from '@client/app/stores/useDataLakeWizardStore';
import type { WizardStep } from '@client/app/stores/useDataLakeWizardStore';
import { useBatchUpload, OFFLINE_MESSAGE } from '@client/app/hooks/data/dataLakeWizard';
import { isValidDataLakeSlug } from '@client/app/hooks/data/dataLakeSlug';
import { hasBlankTagPrefixSegment, isReservedTagPrefix } from '@bike4mind/common';
import WizardStepIndicator from './WizardStepIndicator';
import SourceSelectionStep from './steps/SourceSelectionStep';
import PreviewStep from './steps/PreviewStep';
import ConfigStep from './steps/ConfigStep';
import UploadStep from './steps/UploadStep';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useDuplicatePrefixLake } from '@client/app/hooks/data/dataLakes';

/**
 * The wizard's step order. Preview is opt-in (default off), so the minimal create path is
 * name + files -> config -> upload. AI tag suggestion is also opt-in but no longer a
 * step in this order at all - it runs as a background job after upload, reviewed later from
 * the Data Lakes list.
 *
 * The preview toggle lives on the source step, so an enabled step can only ever be removed
 * while the user is standing on `source` - the current step can't be spliced out from under
 * them, and `indexOf(step)` stays >= 0.
 */
function stepOrderFor(state: { optionalSteps: OptionalSteps }): WizardStep[] {
  return ['source', ...(state.optionalSteps.preview ? (['preview'] as const) : []), 'config', 'upload'];
}

export default function DataLakeWizardModal() {
  const theme = useTheme();
  const isOpen = useDataLakeWizardStore(s => s.isOpen);
  const step = useDataLakeWizardStore(s => s.step);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  const resetWizard = useDataLakeWizardStore(s => s.resetWizard);
  const updateUploadProgress = useDataLakeWizardStore(s => s.updateUploadProgress);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const optionalSteps = useDataLakeWizardStore(s => s.optionalSteps);
  const config = useDataLakeWizardStore(s => s.config);
  const deriveTagPrefixFromName = useDataLakeWizardStore(s => s.deriveTagPrefixFromName);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);

  const batchUpload = useBatchUpload();

  const STEP_ORDER = stepOrderFor({ optionalSteps });
  const duplicatePrefixLake = useDuplicatePrefixLake(config.tagPrefix, !!targetLake);
  const currentIndex = STEP_ORDER.indexOf(step);

  const canGoBack = currentIndex > 0 && step !== 'upload';

  const canGoNext = (() => {
    switch (step) {
      case 'source':
        // Counts INCLUDED files, not raw ones: auto-exclusion can empty a selection on its own
        // (e.g. only junk files picked), and Preview - which used to be the mandatory home of
        // this check - is now skippable, so nothing else would stop the user reaching Start
        // Upload with zero files to send. Identity is gated here too, by the same slug.min(2)
        // rule the server enforces; append mode reuses the lake's own slug.
        return allFiles.some(f => !f.excluded) && (!!targetLake || isValidDataLakeSlug(config.name));
      case 'preview':
        return allFiles.some(f => !f.excluded);
      case 'config':
        // Append mode reuses the target lake's (already valid) slug; create mode must
        // produce a slug the server will accept (slug.min(2)) before Start Upload enables.
        // The prefix has to clear the server's reserved-namespace rule here too, or the whole
        // upload fails at the final step.
        // An overlapping prefix is refused by the server, so block here rather than failing the
        // whole upload at the last step. Same for a blank ":" segment (schema refine).
        return (
          (!!targetLake || isValidDataLakeSlug(config.name)) &&
          config.tagPrefix.trim().length >= 2 &&
          !isReservedTagPrefix(config.tagPrefix) &&
          !hasBlankTagPrefixSegment(config.tagPrefix) &&
          !duplicatePrefixLake
        );
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
    if (!canGoNext || currentIndex >= STEP_ORDER.length - 1) return;

    // Leaving source: derive a tag prefix from the name so the minimal path never stalls on
    // Config's tagPrefix >= 2 gate (the taxonomy step, the prefix's only other former home,
    // was removed, so this now always runs in create mode). Fires on every pass so a rename
    // re-derives; deriveTagPrefixFromName is what decides not to clobber a hand-edited prefix.
    if (step === 'source' && !targetLake) {
      deriveTagPrefixFromName();
    }

    setStep(STEP_ORDER[currentIndex + 1]);
  };

  const handleClose = () => {
    // Files can now be gathered without leaving the source step, so having files - not being
    // past source - is what marks unsaved progress worth confirming away.
    if (allFiles.length > 0) {
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
      const message = OFFLINE_MESSAGE;
      // Mirror useBatchUpload's onError so uploadProgress reflects this failure
      // the same way regardless of which of the two entry points caught it, and
      // reuse its toast id so a repeated offline click/retry replaces the same
      // toast instead of stacking a new one.
      updateUploadProgress({ status: 'error', errorKind: 'network', errorMessage: message });
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
            {targetLake ? `Add Files — ${targetLake.name}` : `Create ${DATA_LAKE}`}
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

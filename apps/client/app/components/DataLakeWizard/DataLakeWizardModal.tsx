import { Box, Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
import {
  useDataLakeWizardStore,
  isTaxonomyStepActive,
  type OptionalSteps,
  type WizardStep,
  type WizardTargetLake,
} from '@client/app/stores/useDataLakeWizardStore';
import { useBatchUpload, OFFLINE_MESSAGE } from '@client/app/hooks/data/dataLakeWizard';
import { isValidDataLakeSlug } from '@client/app/hooks/data/dataLakeSlug';
import { isReservedTagPrefix } from '@bike4mind/common';
import WizardStepIndicator from './WizardStepIndicator';
import SourceSelectionStep from './steps/SourceSelectionStep';
import PreviewStep from './steps/PreviewStep';
import TaxonomyReviewStep from './steps/TaxonomyReviewStep';
import ConfigStep from './steps/ConfigStep';
import UploadStep from './steps/UploadStep';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useDuplicatePrefixLake } from '@client/app/hooks/data/dataLakes';

/**
 * The wizard's step order. Preview and AI taxonomy are opt-in (both default off), so the
 * minimal create path is name + files -> config -> upload. Taxonomy is never offered in
 * append mode: the target lake's tag vocabulary already exists.
 *
 * The opt-in toggles live on the source step, so an enabled step can only ever be removed
 * while the user is standing on `source` - the current step can't be spliced out from under
 * them, and `indexOf(step)` stays >= 0.
 */
function stepOrderFor(state: { optionalSteps: OptionalSteps; targetLake: WizardTargetLake | null }): WizardStep[] {
  return [
    'source',
    ...(state.optionalSteps.preview ? (['preview'] as const) : []),
    ...(isTaxonomyStepActive(state) ? (['taxonomy'] as const) : []),
    'config',
    'upload',
  ];
}

export default function DataLakeWizardModal() {
  const theme = useTheme();
  const isOpen = useDataLakeWizardStore(s => s.isOpen);
  const step = useDataLakeWizardStore(s => s.step);
  const setStep = useDataLakeWizardStore(s => s.setStep);
  const resetWizard = useDataLakeWizardStore(s => s.resetWizard);
  const updateUploadProgress = useDataLakeWizardStore(s => s.updateUploadProgress);
  const allFiles = useDataLakeWizardStore(s => s.allFiles);
  const taxonomy = useDataLakeWizardStore(s => s.taxonomy);
  const optionalSteps = useDataLakeWizardStore(s => s.optionalSteps);
  const config = useDataLakeWizardStore(s => s.config);
  const deriveTagPrefixFromName = useDataLakeWizardStore(s => s.deriveTagPrefixFromName);
  const targetLake = useDataLakeWizardStore(s => s.targetLake);

  const batchUpload = useBatchUpload();

  const STEP_ORDER = stepOrderFor({ optionalSteps, targetLake });
  const duplicatePrefixLake = useDuplicatePrefixLake(config.tagPrefix, !!targetLake);
  const currentIndex = STEP_ORDER.indexOf(step);

  const canGoBack = currentIndex > 0 && step !== 'upload';

  // Nothing to review means nothing to apply, so the step is a pass-through - say so on
  // the button rather than making the user guess whether Next loses anything. Never while
  // analyzing: tags that land after the click would still be applied, so "Skip" would lie.
  const nextLabel =
    step === 'taxonomy' && !taxonomy.analyzing && !taxonomy.tags.some(t => !t.deleted) ? 'Skip' : 'Next';

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
      case 'taxonomy':
        // Gated only while inference is in flight - its result overwrites config.name and
        // config.tagPrefix, so advancing early would clobber what the user types on Config.
        // An empty or failed run never blocks: inference is optional (the endpoint itself
        // degrades to an empty taxonomy when it has no API key), and it used to strand the
        // user here with no way forward.
        return !taxonomy.analyzing;
      case 'config':
        // Append mode reuses the target lake's (already valid) slug; create mode must
        // produce a slug the server will accept (slug.min(2)) before Start Upload enables.
        // The prefix has to clear the server's reserved-namespace rule here too, or the whole
        // upload fails at the final step.
        // An overlapping prefix is refused by the server, so block here rather than failing the
        // whole upload at the last step.
        return (
          (!!targetLake || isValidDataLakeSlug(config.name)) &&
          config.tagPrefix.trim().length >= 2 &&
          !isReservedTagPrefix(config.tagPrefix) &&
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

    // Leaving source with no taxonomy step to set a prefix: derive one from the name so the
    // minimal path never stalls on Config's tagPrefix >= 2 gate. Skipped when taxonomy is on,
    // because setTaxonomy only adopts the inferred prefix while config.tagPrefix is empty -
    // seeding it here would silently suppress the AI's own suggestion. Fires on every pass so a
    // rename re-derives; deriveTagPrefixFromName is what decides not to clobber a hand-edited
    // prefix.
    if (step === 'source' && !targetLake && !isTaxonomyStepActive({ optionalSteps, targetLake })) {
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
                {nextLabel}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
}

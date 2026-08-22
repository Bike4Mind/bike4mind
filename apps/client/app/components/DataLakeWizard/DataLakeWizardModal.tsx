import { Box, Button, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { toast } from 'sonner';
import { useDataLakeWizardStore, type OptionalSteps } from '@client/app/stores/useDataLakeWizardStore';
import type { WizardStep } from '@client/app/stores/useDataLakeWizardStore';
import { useBatchUpload, useCreateLakeFromDrive, OFFLINE_MESSAGE } from '@client/app/hooks/data/dataLakeWizard';
import { isValidDataLakeSlug } from '@client/app/hooks/data/dataLakeSlug';
import {
  hasBlankTagPrefixSegment,
  isReservedTagPrefix,
  submittedTagPrefix,
  MAX_TAG_PREFIX_LENGTH,
  MIN_TAG_PREFIX_LENGTH,
} from '@bike4mind/common';
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
  const pendingDriveFolder = useDataLakeWizardStore(s => s.pendingDriveFolder);

  const batchUpload = useBatchUpload();
  const createLakeFromDrive = useCreateLakeFromDrive();

  // A Drive folder picked during create is a source in its own right, so it satisfies every gate
  // that used to demand local files - that gate is what made a Drive-only lake impossible (#1916).
  const hasIncludedFiles = allFiles.some(f => !f.excluded);
  const hasSource = hasIncludedFiles || !!pendingDriveFolder;
  // Nothing to upload, so the commit is the create + Drive connect, not the upload pipeline.
  const isDriveOnlyCommit = !hasIncludedFiles && !!pendingDriveFolder;
  const commit = isDriveOnlyCommit ? createLakeFromDrive : batchUpload;

  const STEP_ORDER = stepOrderFor({ optionalSteps });
  // What the create request will carry, which is what every rule below judges - see
  // submittedTagPrefix. The overlap lookup gets it too, or a colon-less entry silently
  // matches no lake (normalizeTagPrefix drops it) and the collision goes unreported.
  const effectivePrefix = submittedTagPrefix(config.tagPrefix);
  const duplicatePrefixLake = useDuplicatePrefixLake(effectivePrefix, !!targetLake);
  const currentIndex = STEP_ORDER.indexOf(step);

  const canGoBack = currentIndex > 0 && step !== 'upload';

  const canGoNext = (() => {
    switch (step) {
      case 'source':
        // Counts INCLUDED files, not raw ones: auto-exclusion can empty a selection on its own
        // (e.g. only junk files picked), and Preview - which used to be the mandatory home of
        // this check - is now skippable, so nothing else would stop the user reaching Start
        // Upload with zero files to send. A pending Drive folder is the other way to satisfy it.
        // Identity is gated here too, by the same slug.min(2) rule the server enforces; append
        // mode reuses the lake's own slug.
        return hasSource && (!!targetLake || isValidDataLakeSlug(config.name));
      case 'preview':
        return hasSource;
      case 'config':
        // Source is re-checked, not assumed from having got here: the commit throws without one,
        // and the button must never be the thing that discovers that.
        //
        // Every rule the create endpoint enforces on identity is mirrored here, so a value it
        // will refuse cannot reach Start Upload and fail the whole upload at the last step:
        // slug.min(2), the prefix bounds, the reserved namespace, a blank ":" segment, and an
        // overlap with another lake. Append mode reuses the target lake's (already valid) slug.
        //
        // The create-only rules are guarded with !targetLake: append inherits a STORED prefix
        // the user cannot edit here, and a legacy lake predating a rule must not be locked out
        // of its own uploads over a value this form cannot fix.
        //
        // Judged on the SUBMITTED prefix, not the field: useBatchUpload closes the value with
        // ":" before POSTing, so 30 colon-less characters are 31 on arrival (refused) and a
        // bare "a" is the legal "a:" (accepted). Sizing the field got both of those wrong.
        return (
          hasSource &&
          (!!targetLake || isValidDataLakeSlug(config.name)) &&
          effectivePrefix.length >= MIN_TAG_PREFIX_LENGTH &&
          !isReservedTagPrefix(effectivePrefix) &&
          (!!targetLake ||
            (effectivePrefix.length <= MAX_TAG_PREFIX_LENGTH && !hasBlankTagPrefixSegment(effectivePrefix))) &&
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
    // Files can now be gathered without leaving the source step, so having a source - not being
    // past source - is what marks unsaved progress worth confirming away. A picked Drive folder
    // counts: nothing has been created yet, so closing really does discard it (#1916).
    if (allFiles.length > 0 || pendingDriveFolder) {
      if (!window.confirm('You have unsaved progress. Are you sure you want to close the wizard?')) {
        return;
      }
    }
    resetWizard();
  };

  const handleCommit = () => {
    // Belt-and-suspenders with the same check inside each commit mutation's mutationFn:
    // checking here means the button never even flips into its loading state for
    // the common "already offline" case, instead of depending on the mutation
    // lifecycle to notice and unwind.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const message = OFFLINE_MESSAGE;
      // Mirror the mutation's onError so uploadProgress reflects this failure
      // the same way regardless of which of the two entry points caught it, and
      // reuse its toast id so a repeated offline click/retry replaces the same
      // toast instead of stacking a new one.
      updateUploadProgress({ status: 'error', errorKind: 'network', errorMessage: message });
      toast.error(message, {
        id: 'data-lake-batch-upload-error',
        duration: 8000,
        action: { label: 'Retry', onClick: handleCommit },
      });
      return;
    }
    commit.mutate();
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
                // One commit button, two labels: the testid is deliberately unchanged so every
                // existing selector still finds the wizard's primary action.
                data-testid="wizard-start-upload-btn"
                variant="solid"
                color="success"
                disabled={!canGoNext || commit.isPending}
                loading={commit.isPending}
                onClick={handleCommit}
              >
                {/* Nothing is uploaded on the Drive-only path, so don't call it an upload. */}
                {isDriveOnlyCommit ? 'Create and sync' : 'Start Upload'}
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

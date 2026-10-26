import { useState } from 'react';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { formatBytes, type HubBuildView, type HubModelView } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { AccessSteps } from './AccessSteps';

export interface PullConsent {
  acceptLicense: boolean;
  confirmAccess: boolean;
}

/** Size and license before anything downloads; restricted licenses and gated repos need an explicit tick. */
export function PullDialog({
  model,
  build,
  onConfirm,
  onClose,
}: {
  model: HubModelView;
  build: HubBuildView;
  onConfirm: (consent: PullConsent) => void;
  onClose: () => void;
}) {
  const [acceptLicense, setAcceptLicense] = useState(false);
  const [confirmAccess, setConfirmAccess] = useState(false);
  const restricted = model.licenseKind === 'restricted';
  const ready = (!restricted || acceptLicense) && (!model.needsAccess || confirmAccess);
  const licenseName = model.licenseName ?? 'No license declared';

  return (
    <Modal open onClose={onClose}>
      <ModalDialog size="md" sx={{ maxWidth: 520 }} data-testid="models-pull-dialog">
        <DialogTitle>Download {build.quant ?? build.id}?</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25}>
            <Typography level="body-sm" fontFamily="code">
              {model.id}
            </Typography>
            <Typography level="body-sm" data-testid="models-pull-dialog-size">
              {formatBytes(build.sizeBytes)} download
              {model.projectorBytes ? `, plus a vision projector of up to ${formatBytes(model.projectorBytes)}` : ''}.
              Ollama stores it with your other local models; you can remove it from Installed at any time.
            </Typography>
            <Typography level="body-sm" data-testid="models-pull-dialog-license">
              License: <strong>{licenseName}</strong>{' '}
              <ExternalLink href={model.licenseUrl} testId="models-pull-dialog-license-link">
                Read it
              </ExternalLink>
            </Typography>
            {restricted && (
              <Checkbox
                size="sm"
                checked={acceptLicense}
                onChange={event => setAcceptLicense(event.target.checked)}
                label={
                  model.licenseName
                    ? `I have read the ${model.licenseName} license and accept its terms.`
                    : 'This repo declares no license. I accept the terms on its model card.'
                }
                slotProps={{ input: { 'data-testid': 'models-pull-dialog-license-checkbox' } }}
              />
            )}
            {model.needsAccess && (
              <>
                <AccessSteps model={model} />
                <Checkbox
                  size="sm"
                  checked={confirmAccess}
                  onChange={event => setConfirmAccess(event.target.checked)}
                  label="I have access to this repo and added my Ollama key to Hugging Face."
                  slotProps={{ input: { 'data-testid': 'models-pull-dialog-access-checkbox' } }}
                />
              </>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            disabled={!ready}
            onClick={() => onConfirm({ acceptLicense, confirmAccess })}
            data-testid="models-pull-dialog-confirm-btn"
          >
            Download {formatBytes(build.sizeBytes)}
          </Button>
          <Button variant="plain" color="neutral" onClick={onClose} data-testid="models-pull-dialog-cancel-btn">
            Not now
          </Button>
        </DialogActions>
      </ModalDialog>
    </Modal>
  );
}

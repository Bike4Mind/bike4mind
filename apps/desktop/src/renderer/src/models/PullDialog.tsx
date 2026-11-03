import { useEffect, useState } from 'react';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { formatBytes, type HubBuildView, type HubModelView, type ModelStoreLocation } from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { AccessSteps } from './AccessSteps';
import { FitBadge } from './FitBadge';
import type { ModelTarget } from './modelTarget';

export interface PullConsent {
  acceptLicense: boolean;
  confirmAccess: boolean;
}

function joinNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : (names[0] ?? '');
}

function useStoreLocation(target: ModelTarget): ModelStoreLocation | null | 'failed' {
  const [location, setLocation] = useState<ModelStoreLocation | null | 'failed'>(null);
  const serverId = target.local ? undefined : target.id;
  useEffect(() => {
    let live = true;
    window.b4m.models.getStoreLocation(serverId).then(
      next => live && setLocation(next),
      () => live && setLocation('failed')
    );
    return () => {
      live = false;
    };
  }, [serverId]);
  return location;
}

/** Where the download lands; Ollama has no setting Desktop can read, so an unconfirmed folder says so. */
function StoreLine({
  location,
  server,
  needed,
}: {
  location: ModelStoreLocation | null | 'failed';
  server: string | null;
  needed: number;
}) {
  if (location === null)
    return (
      <Typography level="body-sm" textColor="text.tertiary" data-testid="models-pull-dialog-path" data-state="checking">
        Checking where {server ? `${server} keeps` : 'Ollama keeps'} models...
      </Typography>
    );
  const path = location === 'failed' ? null : location.path;
  const source = (path && location !== 'failed' && location.source) || null;
  const free = location === 'failed' ? null : location.freeBytes;
  const short = free !== null && free < needed;
  const folder = path && <Typography fontFamily="code">{path}</Typography>;
  return (
    <Typography
      level="body-sm"
      color={short ? 'danger' : undefined}
      data-testid="models-pull-dialog-path"
      data-state={source === 'runtime' ? 'confirmed' : (source ?? 'unknown')}
    >
      {server ? (
        path ? (
          <>
            Saved on {server} in {folder}.
          </>
        ) : (
          <>Saved with the other models on {server}.</>
        )
      ) : source === 'runtime' ? (
        <>Saved to {folder}.</>
      ) : source === 'elsewhere' ? (
        <>
          Saved where Ollama keeps its models, {folder} as Ollama reports it. That folder is not on this computer&apos;s
          disk, so Ollama may be running in a container or on another machine.
        </>
      ) : source === 'default' ? (
        <>Saved to Ollama&apos;s model folder, {folder} unless Ollama is set to use another one.</>
      ) : (
        <>Saved to Ollama&apos;s model folder.</>
      )}
      {free !== null && ` ${formatBytes(free)} free${short ? ', which is not enough for this download' : ''}.`}
    </Typography>
  );
}

/**
 * Size, fit and license before anything downloads; restricted licenses, gated repos and builds too large for
 * this computer need an explicit tick.
 */
export function PullDialog({
  model,
  build,
  target,
  onConfirm,
  onClose,
}: {
  model: HubModelView;
  build: HubBuildView;
  target: ModelTarget;
  onConfirm: (consent: PullConsent) => void;
  onClose: () => void;
}) {
  const server = target.local ? null : target.name;
  const location = useStoreLocation(target);
  const [acceptLicense, setAcceptLicense] = useState(false);
  const [confirmAccess, setConfirmAccess] = useState(false);
  const [overrideFit, setOverrideFit] = useState(false);
  const restricted = model.licenseKind === 'restricted';
  const tooLarge = build.fit?.level === 'too-large';
  const ready = (!restricted || acceptLicense) && (!model.needsAccess || confirmAccess) && (!tooLarge || overrideFit);
  const names = model.licenseNames;
  const several = names.length > 1;
  const acceptLabel =
    names.length === 0
      ? 'This repo declares no license. I accept the terms on its model card.'
      : `I have read the ${joinNames(names)} license${several ? 's' : ''} and accept ${several ? 'their' : 'its'} terms.`;

  return (
    <Modal open onClose={onClose}>
      <ModalDialog size="md" sx={{ maxWidth: 520 }} data-testid="models-pull-dialog">
        <DialogTitle>Download {build.label}?</DialogTitle>
        <DialogContent>
          {/* Joy's checkbox hit area sits 1px outside its box, which otherwise scrolls this content both ways. */}
          <Stack spacing={1.25} sx={{ p: '1px' }}>
            <Typography level="body-sm" fontFamily="code">
              {model.id}
            </Typography>
            <Typography level="body-sm" data-testid="models-pull-dialog-size">
              {formatBytes(build.sizeBytes)} download
              {model.projectorBytes ? `, plus a vision projector of up to ${formatBytes(model.projectorBytes)}` : ''}.
              {server
                ? ` ${server} downloads it straight from Hugging Face; you can remove it from Installed at any time.`
                : ' Ollama downloads it; you can remove it from Installed at any time.'}
            </Typography>
            <StoreLine location={location} server={server} needed={build.sizeBytes + (model.projectorBytes ?? 0)} />
            {server && (
              <Typography level="body-sm" data-testid="models-pull-dialog-server">
                Desktop cannot see how much free space {server} has. Keep Bike4Mind open until the download finishes.
              </Typography>
            )}
            {build.fit && (
              <Stack direction="row" spacing={1} alignItems="flex-start" data-testid="models-pull-dialog-fit">
                <FitBadge fit={build.fit} bare />
                <Typography level="body-sm">{build.fit.detail}</Typography>
              </Stack>
            )}
            {tooLarge && (
              <Checkbox
                size="sm"
                checked={overrideFit}
                onChange={event => setOverrideFit(event.target.checked)}
                label={`Download it anyway. It may fail to load or make ${server ?? 'this computer'} swap.`}
                slotProps={{ input: { 'data-testid': 'models-pull-dialog-fit-checkbox' } }}
              />
            )}
            <Typography level="body-sm" data-testid="models-pull-dialog-license">
              {several ? 'Licenses' : 'License'}:{' '}
              <strong>{names.length ? names.join(', ') : 'No license declared'}</strong>{' '}
              <ExternalLink href={model.licenseUrl} testId="models-pull-dialog-license-link">
                Read it
              </ExternalLink>{' '}
              ({model.licenseHost})
            </Typography>
            {restricted && (
              <Checkbox
                size="sm"
                checked={acceptLicense}
                onChange={event => setAcceptLicense(event.target.checked)}
                label={acceptLabel}
                slotProps={{ input: { 'data-testid': 'models-pull-dialog-license-checkbox' } }}
              />
            )}
            {model.needsAccess && (
              <>
                <AccessSteps model={model} server={server} />
                <Checkbox
                  size="sm"
                  checked={confirmAccess}
                  onChange={event => setConfirmAccess(event.target.checked)}
                  label={
                    server
                      ? `I added the Ollama key of ${server} to the Hugging Face account that has access.`
                      : "I added Ollama's public key to the Hugging Face account that has access."
                  }
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

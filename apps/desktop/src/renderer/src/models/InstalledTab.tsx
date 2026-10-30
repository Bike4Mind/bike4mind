import { useEffect, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import {
  OLLAMA_DOWNLOAD_URL,
  formatBytes,
  type InstalledModelsResult,
  type LocalModelEntry,
  type ModelRuntimeStatus,
} from '@shared/models';
import { ExternalLink } from '../chat/ExternalLink';
import { TrashIcon } from '../chat/icons';
import { FitBadge } from './FitBadge';
import type { ModelTarget } from './modelTarget';

/** A device-side model a chat points at: its Ollama name and the server it runs on. */
export interface ModelInUse {
  serverId: string;
  name: string;
}

/** The device-side models chats point at, so removing one can warn first. */
export interface ModelsInUse {
  /** The open conversation's model, when it is a device-side one. */
  active: ModelInUse | null;
  /** One entry per conversation that uses a device-side model, archived ones left out. */
  conversations: readonly ModelInUse[];
}

function inUseWarning(model: LocalModelEntry, serverId: string, inUse: ModelsInUse | undefined): string | null {
  const lines: string[] = [];
  const same = (entry: ModelInUse | null) => entry?.serverId === serverId && entry.name === model.name;
  if (same(inUse?.active ?? null))
    lines.push('The open conversation uses this model. Pick another model there before your next message.');
  else {
    const count = inUse?.conversations.filter(same).length ?? 0;
    if (count > 0)
      lines.push(
        `${count} ${count === 1 ? 'conversation uses' : 'conversations use'} this model. ` +
          'Pick another model in them before sending again.'
      );
  }
  if (model.loaded) lines.push('Ollama has it loaded right now.');
  return lines.length ? lines.join(' ') : null;
}

const CAPABILITY_LABELS: [keyof LocalModelEntry['capabilities'], string][] = [
  ['tools', 'Tools'],
  ['vision', 'Vision'],
  ['thinking', 'Thinking'],
  ['embeddings', 'Embeddings'],
];

/** Contexts are set in powers of two, so 4096 reads as 4K and 131072 as 128K. */
function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

function InstalledRow({ model, onRemove }: { model: LocalModelEntry; onRemove: (() => void) | null }) {
  return (
    <Sheet
      variant="outlined"
      sx={{ borderRadius: 'md', px: 1.5, py: 1.25, display: 'flex', alignItems: 'center', gap: 1.5 }}
      data-testid="models-installed-row"
      data-name={model.name}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ minWidth: 0 }}>
          <Typography level="title-sm" fontFamily="code" noWrap>
            {model.name}
          </Typography>
          {model.loaded && (
            <Chip size="sm" color="success" variant="soft" data-testid="models-installed-loaded-chip">
              Loaded
            </Chip>
          )}
          <FitBadge fit={model.fit} />
          {model.baseModel && (
            <Chip size="sm" variant="soft" color="primary" data-testid="models-installed-lora-chip">
              LoRA on {model.baseModel}
            </Chip>
          )}
        </Stack>
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75} sx={{ mt: 0.75 }}>
          <Typography level="body-xs" textColor="text.tertiary">
            {formatBytes(model.sizeBytes)}
          </Typography>
          {model.contextLength && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="models-installed-context">
              {contextLabel(model.contextLength)} context
            </Typography>
          )}
          {model.aliases && model.aliases.length > 0 && (
            <Typography level="body-xs" textColor="text.tertiary" data-testid="models-installed-aliases">
              Also served as {model.aliases.join(', ')}
            </Typography>
          )}
          {model.quantization && (
            <Typography level="body-xs" textColor="text.tertiary">
              {model.quantization}
            </Typography>
          )}
          {model.parameterSize && (
            <Typography level="body-xs" textColor="text.tertiary">
              {model.parameterSize}
            </Typography>
          )}
          {CAPABILITY_LABELS.filter(([key]) => model.capabilities[key]).map(([key, label]) => (
            <Chip key={key} size="sm" variant="outlined" color="neutral">
              {label}
            </Chip>
          ))}
        </Stack>
      </Box>
      {onRemove && (
        <Button
          size="sm"
          variant="plain"
          color="danger"
          startDecorator={<TrashIcon />}
          onClick={onRemove}
          data-testid="models-installed-remove-btn"
        >
          Remove
        </Button>
      )}
    </Sheet>
  );
}

export function InstalledTab({
  status,
  target,
  installed,
  inUse,
  onRetry,
  onExplore,
}: {
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  installed: InstalledModelsResult | null;
  inUse?: ModelsInUse;
  onRetry: () => void;
  onExplore: () => void;
}) {
  // The server is kept with the model, so a confirmation never acts on a server other than the one it named.
  const [confirmingOn, setConfirming] = useState<{ model: LocalModelEntry; serverId: string | undefined } | null>(null);
  const confirming = confirmingOn?.model ?? null;
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const canManage = target.management === 'allowed';

  useEffect(() => {
    if (!canManage) setConfirming(null);
  }, [canManage]);

  const remove = async (model: LocalModelEntry, serverId: string | undefined) => {
    setRemoving(true);
    const result = await window.b4m.models.remove(model.name, serverId);
    setRemoving(false);
    setConfirming(null);
    setRemoveError(result.ok ? null : result.error.message);
  };

  if (status && !status.reachable && !target.local)
    return (
      <Stack
        alignItems="center"
        spacing={1}
        sx={{ py: 6, textAlign: 'center' }}
        data-testid="models-installed-runtime-down"
      >
        <Typography level="title-md">{target.name} is not reachable</Typography>
        <Typography level="body-sm" sx={{ maxWidth: 440 }}>
          {status.error ?? `Desktop could not reach ${target.name}.`}
        </Typography>
        <Button size="sm" variant="outlined" color="neutral" onClick={onRetry}>
          Check again
        </Button>
      </Stack>
    );
  if (status && !status.reachable)
    return (
      <Stack
        alignItems="center"
        spacing={1}
        sx={{ py: 6, textAlign: 'center' }}
        data-testid="models-installed-runtime-down"
      >
        <Typography level="title-md">Ollama is not running</Typography>
        <Typography level="body-sm" sx={{ maxWidth: 440 }}>
          Local models run in Ollama. Start it if it is installed, or download it from{' '}
          <ExternalLink href={OLLAMA_DOWNLOAD_URL} testId="models-installed-download-link">
            ollama.com/download
          </ExternalLink>
          , then check again.
        </Typography>
        <Button size="sm" variant="outlined" color="neutral" onClick={onRetry}>
          Check again
        </Button>
      </Stack>
    );
  if (!installed)
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
        <CircularProgress size="sm" />
      </Box>
    );
  if (!installed.ok)
    return (
      <Alert color="danger" variant="soft" data-testid="models-installed-error">
        {installed.error.message}
      </Alert>
    );

  const total = installed.models.reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0);
  const warning = confirming ? inUseWarning(confirming, target.id, inUse) : null;
  return (
    <Stack spacing={1}>
      {removeError && (
        <Alert color="danger" variant="soft" data-testid="models-remove-error">
          {removeError}
        </Alert>
      )}
      {installed.models.length === 0 ? (
        <Stack alignItems="center" spacing={1} sx={{ py: 6, textAlign: 'center' }} data-testid="models-installed-empty">
          <Typography level="title-md">
            {target.local ? 'No local models yet' : `No models on ${target.name} yet`}
          </Typography>
          {canManage && (
            <>
              <Typography level="body-sm">Find an open model on Hugging Face and download it here.</Typography>
              <Button size="sm" onClick={onExplore} data-testid="models-installed-explore-btn">
                Explore models
              </Button>
            </>
          )}
        </Stack>
      ) : (
        <>
          <Typography level="body-xs" textColor="text.tertiary" data-testid="models-installed-summary">
            {installed.models.length} {installed.models.length === 1 ? 'model' : 'models'}
            {target.local || total > 0 ? `, ${formatBytes(total)} on disk` : ''}
            {target.local ? '' : ` on ${target.name}`}
          </Typography>
          {installed.models.map(model => (
            <InstalledRow
              key={model.name}
              model={model}
              onRemove={
                canManage ? () => setConfirming({ model, serverId: target.local ? undefined : target.id }) : null
              }
            />
          ))}
        </>
      )}

      <Modal open={canManage && confirming !== null} onClose={() => !removing && setConfirming(null)}>
        <ModalDialog size="sm" role="alertdialog" data-testid="models-remove-dialog">
          <DialogTitle>Remove {confirming?.name}?</DialogTitle>
          <DialogContent>
            This deletes it from Ollama{target.local ? '' : ` on ${target.name}`} and frees{' '}
            {formatBytes(confirming?.sizeBytes ?? null)}
            {target.local ? '' : ' there'}. You can download it again later.
            {warning && (
              <Alert color="warning" variant="soft" sx={{ mt: 1 }} data-testid="models-remove-dialog-in-use">
                {warning}
              </Alert>
            )}
          </DialogContent>
          <DialogActions>
            <Button
              color="danger"
              loading={removing}
              onClick={() => confirmingOn && void remove(confirmingOn.model, confirmingOn.serverId)}
              data-testid="models-remove-dialog-confirm-btn"
            >
              Remove
            </Button>
            <Button
              variant="plain"
              color="neutral"
              disabled={removing}
              onClick={() => setConfirming(null)}
              data-testid="models-remove-dialog-cancel-btn"
            >
              Keep it
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Stack>
  );
}

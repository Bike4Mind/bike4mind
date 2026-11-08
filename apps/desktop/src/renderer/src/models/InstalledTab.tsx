import { useEffect, useId, useState } from 'react';
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
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatModelOption } from '@shared/chat';
import { formatBytes, type InstalledModelsResult, type LocalModelEntry, type ModelRuntimeStatus } from '@shared/models';
import { LOCAL_SERVER_ID } from '@shared/modelServers';
import { TrashIcon } from '../chat/icons';
import { FitBadge } from './FitBadge';
import { installedCache, listedAtLabel, type LastInstalled } from './installedCache';
import { hasModelDefaults, ModelDefaultsDialog } from './ModelDefaultsDialog';
import { OLLAMA_NOT_RUNNING } from './localRuntimeCopy';
import type { ChatOn, ModelOn, ModelTarget } from './modelTarget';

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

const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/** Contexts are set in powers of two, so 4096 reads as 4K and 131072 as 128K. */
function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}

function InstalledRow({
  model,
  onUse,
  onSettings,
  onRemove,
  removeBlocked,
}: {
  model: LocalModelEntry;
  onUse: (() => void) | null;
  onSettings: (() => void) | null;
  onRemove: (() => void) | null;
  /** Why Remove is shown disabled; null when it is usable. */
  removeBlocked: string | null;
}) {
  const blockedId = useId();
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
      {onUse && (
        <Button size="sm" variant="soft" onClick={onUse} data-testid="models-installed-use-btn">
          Use in chat
        </Button>
      )}
      {onSettings && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          onClick={onSettings}
          aria-label={`Settings for ${model.name}`}
          data-testid="models-installed-settings-btn"
        >
          Settings
        </Button>
      )}
      {!onUse && model.capabilities.embeddings && !model.capabilities.completion && (
        <Typography level="body-xs" textColor="text.tertiary" role="note" data-testid="models-installed-embedding-note">
          Embedding model, not for chat
        </Typography>
      )}
      {onRemove && !removeBlocked && (
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
      {onRemove && removeBlocked && (
        <>
          <Tooltip title={removeBlocked} size="sm" variant="soft" describeChild>
            {/* aria-disabled rather than disabled keeps it focusable, so keyboard and screen reader users get the reason. */}
            <Button
              size="sm"
              variant="plain"
              color="danger"
              startDecorator={<TrashIcon />}
              aria-disabled="true"
              aria-describedby={blockedId}
              sx={{ opacity: 0.5, cursor: 'default' }}
              data-testid="models-installed-remove-btn"
            >
              Remove
            </Button>
          </Tooltip>
          <Box component="span" id={blockedId} sx={visuallyHidden}>
            {removeBlocked}
          </Box>
        </>
      )}
    </Sheet>
  );
}

export function InstalledTab({
  status,
  target,
  installed,
  lastInstalled = null,
  inUse,
  chatOn,
  modelOn,
  onRetry,
  onExplore,
}: {
  status: ModelRuntimeStatus | null;
  target: ModelTarget;
  installed: InstalledModelsResult | null;
  /** Shown, marked as such, until `installed` is a fresh listing from a reachable server. */
  lastInstalled?: LastInstalled | null;
  inUse?: ModelsInUse;
  chatOn?: ChatOn;
  /** Chat's entry for an installed model, whose controls say which defaults it takes. */
  modelOn?: ModelOn;
  onRetry: () => void;
  onExplore: () => void;
}) {
  const [settingsFor, setSettingsFor] = useState<ChatModelOption | null>(null);
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
    const cacheId = serverId ?? LOCAL_SERVER_ID;
    setRemoving(true);
    installedCache.cutListings(cacheId);
    const result = await window.b4m.models.remove(model.name, serverId);
    installedCache.cutListings(cacheId);
    if (result.ok) installedCache.dropModel(cacheId, model.name);
    setRemoving(false);
    setConfirming(null);
    setRemoveError(result.ok ? null : result.error.message);
  };

  const last = status?.reachable && installed?.ok ? null : lastInstalled;
  const lastProblem = !last
    ? null
    : status && !status.reachable
      ? target.local
        ? OLLAMA_NOT_RUNNING
        : (status.error ?? `Desktop could not reach ${target.name}.`)
      : installed && !installed.ok
        ? installed.error.message
        : null;

  if (!last && status && !status.reachable && !target.local)
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
  if (!last && status && !status.reachable)
    return (
      <Stack
        alignItems="center"
        spacing={1}
        sx={{ py: 6, textAlign: 'center' }}
        data-testid="models-installed-runtime-down"
      >
        <Typography level="title-md">{OLLAMA_NOT_RUNNING}</Typography>
        <Typography level="body-sm" sx={{ maxWidth: 440 }}>
          Your Ollama models show here once it is running. The banner above shows how to start it.
        </Typography>
      </Stack>
    );
  if (!last && !installed)
    return (
      <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
        <CircularProgress size="sm" />
      </Box>
    );
  if (!last && !installed?.ok)
    return (
      <Alert color="danger" variant="soft" data-testid="models-installed-error">
        {installed && !installed.ok ? installed.error.message : null}
      </Alert>
    );

  const models = last ? last.models : installed?.ok ? installed.models : [];
  const total = models.reduce((sum, model) => sum + (model.sizeBytes ?? 0), 0);
  const warning = confirming ? inUseWarning(confirming, target.id, inUse) : null;
  return (
    <Stack spacing={1}>
      {last && (
        <Alert
          color={lastProblem ? 'warning' : 'neutral'}
          variant="soft"
          size="sm"
          startDecorator={
            lastProblem ? null : <CircularProgress size="sm" sx={{ '--CircularProgress-size': '16px' }} />
          }
          endDecorator={
            lastProblem && (
              <Button
                size="sm"
                variant="plain"
                color="warning"
                onClick={onRetry}
                data-testid="models-installed-stale-retry-btn"
              >
                Check again
              </Button>
            )
          }
          data-testid={lastProblem ? 'models-installed-stale' : 'models-installed-refreshing'}
        >
          <Stack>
            <Typography level="body-sm" textColor="inherit" data-testid="models-installed-stale-reason">
              {lastProblem ?? 'Refreshing'}
            </Typography>
            <Typography level="body-xs" textColor="inherit">
              Showing the list from {listedAtLabel(last.listedAt)}.
            </Typography>
          </Stack>
        </Alert>
      )}
      {removeError && (
        <Alert color="danger" variant="soft" data-testid="models-remove-error">
          {removeError}
        </Alert>
      )}
      {models.length === 0 ? (
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
            {models.length} {models.length === 1 ? 'model' : 'models'}
            {target.local || total > 0 ? `, ${formatBytes(total)} on disk` : ''}
            {target.local ? '' : ` on ${target.name}`}
          </Typography>
          {models.map(model => {
            const option = modelOn?.(model.name) ?? null;
            return (
              <InstalledRow
                key={model.name}
                model={model}
                onUse={chatOn?.(model.name) ?? null}
                onSettings={option && hasModelDefaults(option) ? () => setSettingsFor(option) : null}
                onRemove={
                  canManage ? () => setConfirming({ model, serverId: target.local ? undefined : target.id }) : null
                }
                removeBlocked={last ? 'Available once the list refreshes' : null}
              />
            );
          })}
        </>
      )}

      <ModelDefaultsDialog option={settingsFor} onClose={() => setSettingsFor(null)} onSaved={onRetry} />

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

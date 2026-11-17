import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Divider from '@mui/joy/Divider';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { StudioAsset, StudioMediaKind } from '@shared/studio';
import { CloseIcon, ImageIcon, MusicIcon, SoundIcon, VideoIcon, VoiceIcon } from '../icons';
import { thinScrollbarSx } from '../layout';
import type { StudioController, StudioCreationDraft, StudioReview } from './controller';
import { STUDIO_PANE_WIDTH } from './layout';

export const STUDIO_TILES: readonly { kind: StudioMediaKind; label: string; icon: ReactNode }[] = [
  { kind: 'image', label: 'Image', icon: <ImageIcon /> },
  { kind: 'video', label: 'Video', icon: <VideoIcon /> },
  { kind: 'music', label: 'Music', icon: <MusicIcon /> },
  { kind: 'speech', label: 'Voice', icon: <VoiceIcon /> },
  { kind: 'sound-effect', label: 'Sound FX', icon: <SoundIcon /> },
];

const mediaLabel = (kind: StudioMediaKind) => STUDIO_TILES.find(tile => tile.kind === kind)?.label ?? kind;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : 'Studio could not complete this operation.';
const selectSx = {
  width: '100%',
  minWidth: 0,
  p: 0.75,
  borderRadius: 'sm',
  border: '1px solid',
  borderColor: 'neutral.outlinedBorder',
  bgcolor: 'background.surface',
  color: 'text.primary',
  font: 'inherit',
} as const;

function CreationForm({
  controller,
  kind,
  onBack,
}: {
  controller: StudioController;
  kind: StudioMediaKind;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<StudioCreationDraft>(() => ({
    sessionId: controller.sessionId,
    workspaceId: controller.workspaceId,
    revision: controller.revision,
    kind,
    prompt: '',
    selection: { mode: 'session-family' },
    settings: {},
  }));
  const [review, setReview] = useState<StudioReview | null>(null);
  const [preparedPrompt, setPreparedPrompt] = useState('');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'creating'>('idle');
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const capability = controller.capabilities[kind];
  const locked = !!controller.busy || phase === 'creating' || capability?.status !== 'available';
  useEffect(
    () => () => {
      epoch.current++;
    },
    []
  );
  useEffect(() => {
    epoch.current++;
    setReview(null);
    setPhase('idle');
  }, [controller.busy, capability?.status]);

  const edit = (next: StudioCreationDraft) => {
    epoch.current++;
    setDraft(next);
    setReview(null);
    setError(null);
    setPhase('idle');
  };
  const prepare = async () => {
    if (locked || phase !== 'idle' || !form.current?.reportValidity()) return;
    const request = ++epoch.current;
    setPhase('preparing');
    setError(null);
    setReview(null);
    try {
      const result = await controller.prepareCreation(draft);
      if (request !== epoch.current) return;
      setReview(result);
      setPreparedPrompt(result.preparedPrompt);
    } catch (cause) {
      if (request === epoch.current) setError(errorText(cause));
    } finally {
      if (request === epoch.current) setPhase('idle');
    }
  };
  const create = async () => {
    if (!review || locked || phase !== 'idle' || !preparedPrompt.trim()) return;
    const request = ++epoch.current;
    setPhase('creating');
    setError(null);
    try {
      await controller.create({ draft, reviewId: review.id, preparedPrompt });
      if (request === epoch.current) onBack();
    } catch (cause) {
      if (request === epoch.current) setError(errorText(cause));
    } finally {
      if (request === epoch.current) setPhase('idle');
    }
  };
  return (
    <Stack
      component="form"
      ref={form}
      onSubmit={event => event.preventDefault()}
      spacing={1.5}
      data-testid="studio-creation-form"
    >
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onBack}
        disabled={phase === 'creating'}
        data-testid="studio-creation-back-btn"
      >
        Back to Studio
      </Button>
      <Typography level="title-sm">Create {mediaLabel(kind)}</Typography>
      <FormControl disabled={locked}>
        <FormLabel>{kind === 'speech' ? 'Script or instructions' : 'What would you like to create?'}</FormLabel>
        <Textarea
          minRows={3}
          value={draft.prompt}
          onChange={event => edit({ ...draft, prompt: event.target.value })}
          slotProps={{ textarea: { 'data-testid': 'studio-prompt-input' } }}
        />
      </FormControl>
      <FormControl disabled={locked}>
        <FormLabel>Context scope</FormLabel>
        <Box
          component="select"
          aria-label="Context scope"
          value={draft.selection.mode}
          disabled={locked}
          sx={selectSx}
          data-testid="studio-context-select"
          onChange={event => {
            const mode = event.target.value;
            if (mode === 'current-session' || mode === 'session-family' || mode === 'custom')
              edit({ ...draft, selection: { mode, ...(mode === 'custom' ? { sessionIds: [] } : {}) } });
          }}
        >
          <option value="current-session">Current session</option>
          <option value="session-family">Session family</option>
          <option value="custom">Custom</option>
        </Box>
      </FormControl>
      {draft.selection.mode === 'custom' && (
        <Stack spacing={1} role="group" aria-label="Context sessions" data-testid="studio-context-sessions">
          {controller.sessions.map(session => (
            <Checkbox
              key={session.id}
              size="sm"
              label={session.title}
              disabled={locked}
              checked={draft.selection.sessionIds?.includes(session.id) ?? false}
              onChange={event => {
                const selected = draft.selection.sessionIds ?? [];
                edit({
                  ...draft,
                  selection: {
                    mode: 'custom',
                    sessionIds: event.target.checked
                      ? [...selected, session.id]
                      : selected.filter(id => id !== session.id),
                  },
                });
              }}
              slotProps={{ input: { 'data-testid': `studio-context-${session.id}-checkbox` } }}
            />
          ))}
          {controller.sessions.length === 0 && (
            <Typography level="body-xs">No sessions available for selection.</Typography>
          )}
        </Stack>
      )}
      {capability?.status === 'available' &&
        capability.fields?.map(field => {
          if (!field) return null;
          const value = draft.settings[field.key as keyof typeof draft.settings];
          const change = (next: string | number | boolean | undefined) =>
            edit({ ...draft, settings: { ...draft.settings, [field.key]: next } } as StudioCreationDraft);
          return (
            <FormControl key={field.key} disabled={locked}>
              {field.type !== 'boolean' && <FormLabel>{field.label}</FormLabel>}
              {field.type === 'boolean' ? (
                <Checkbox
                  label={field.label}
                  disabled={locked}
                  checked={Boolean(value)}
                  onChange={event => change(event.target.checked)}
                  slotProps={{ input: { 'data-testid': `studio-setting-${field.key}` } }}
                />
              ) : field.type === 'choice' ? (
                <Box
                  component="select"
                  aria-label={field.label}
                  disabled={locked}
                  sx={selectSx}
                  value={String(value ?? '')}
                  data-testid={`studio-setting-${field.key}`}
                  onChange={event => change(event.target.value || undefined)}
                >
                  <option value="">Default</option>
                  {field.options.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Box>
              ) : (
                <Input
                  type="number"
                  value={value ?? ''}
                  onChange={event => change(event.target.value === '' ? undefined : Number(event.target.value))}
                  slotProps={{
                    input: {
                      min: field.min,
                      max: field.max,
                      step: field.step ?? 1,
                      'data-testid': `studio-setting-${field.key}`,
                    },
                  }}
                />
              )}
            </FormControl>
          );
        })}
      {capability?.status !== 'available' && (
        <Alert size="sm" color="neutral">
          {capability?.reason ?? 'This media type is not supported.'}
        </Alert>
      )}
      <Button
        size="sm"
        variant="soft"
        disabled={
          locked || !draft.prompt.trim() || (draft.selection.mode === 'custom' && !draft.selection.sessionIds?.length)
        }
        loading={phase === 'preparing'}
        onClick={() => void prepare()}
        data-testid="studio-prepare-btn"
      >
        Review context and {kind === 'speech' ? 'script' : 'prompt'}
      </Button>
      {review && (
        <Stack spacing={1} data-testid="studio-context-review">
          <Typography level="title-sm">Review before creating</Typography>
          <Typography level="body-xs">Included sessions</Typography>
          {review.sources.map(source => (
            <Typography level="body-xs" key={source.sessionId}>
              {source.title}
            </Typography>
          ))}
          {review.sources.length === 0 && <Typography level="body-xs">No session context included.</Typography>}
          {(
            [
              ['Excluded', review.exclusions],
              ['Truncated', review.truncation],
              ['Warning', review.warnings],
            ] as const
          ).map(([label, messages]) =>
            messages.map((message, index) => (
              <Alert key={`${label}-${index}`} size="sm" color="warning">
                {label}: {message}
              </Alert>
            ))
          )}
          <FormControl disabled={locked}>
            <FormLabel>{kind === 'speech' ? 'Prepared script' : 'Prepared prompt'}</FormLabel>
            <Textarea
              minRows={5}
              value={preparedPrompt}
              onChange={event => setPreparedPrompt(event.target.value)}
              slotProps={{ textarea: { 'data-testid': 'studio-prepared-input' } }}
            />
          </FormControl>
          <Button
            size="sm"
            disabled={locked || !preparedPrompt.trim()}
            loading={phase === 'creating'}
            onClick={() => void create()}
            data-testid="studio-create-btn"
          >
            Create {mediaLabel(kind)}
          </Button>
        </Stack>
      )}
      {error && (
        <Alert size="sm" color="danger" data-testid="studio-creation-error">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

function AssetPreview({
  asset,
  controller,
  onBack,
}: {
  asset: StudioAsset;
  controller: StudioController;
  onBack: () => void;
}) {
  const [title, setTitle] = useState(asset.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = async (action: () => Promise<void>, close = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (close) onBack();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5} data-testid="studio-asset-preview">
      <Button
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onBack}
        disabled={busy}
        data-testid="studio-preview-back-btn"
      >
        Back to Studio
      </Button>
      <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }}>
        {asset.title}
      </Typography>
      <Typography level="body-xs">
        {mediaLabel(asset.kind)} - {asset.mimeType ?? 'Media asset'}
      </Typography>
      {asset.prompt && (
        <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {asset.prompt}
        </Typography>
      )}
      <FormControl disabled={!controller.renameAsset || busy}>
        <FormLabel>Asset name</FormLabel>
        <Input
          value={title}
          onChange={event => setTitle(event.target.value)}
          slotProps={{ input: { 'data-testid': 'studio-asset-title-input' } }}
        />
      </FormControl>
      {(['preview', 'rename', 'export', 'reuse', 'delete'] as const).map(action => {
        const callback = {
          preview: controller.previewAsset,
          rename: controller.renameAsset
            ? (item: StudioAsset) => controller.renameAsset?.(item, title.trim()) ?? Promise.resolve()
            : undefined,
          export: controller.exportAsset,
          reuse: controller.reuseAsset,
          delete: controller.deleteAsset,
        }[action];
        const reason =
          controller.assetActionReasons?.[action] ??
          (!callback ? `${action[0].toUpperCase()}${action.slice(1)} is not connected yet.` : null);
        return (
          <Box key={action}>
            <Button
              size="sm"
              variant="soft"
              color={action === 'delete' ? 'danger' : 'neutral'}
              disabled={busy || !!controller.busy || !callback || !!reason || (action === 'rename' && !title.trim())}
              data-testid={`studio-asset-${action}-btn`}
              onClick={() => {
                if (!callback) return;
                if (action === 'delete' && !confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                void run(() => callback(asset), action === 'delete');
              }}
            >
              {action === 'delete' && confirmDelete ? 'Confirm delete' : `${action[0].toUpperCase()}${action.slice(1)}`}
            </Button>
            {reason && (
              <Typography level="body-xs" textColor="text.tertiary">
                {reason}
              </Typography>
            )}
          </Box>
        );
      })}
      {confirmDelete && (
        <Button
          size="sm"
          variant="plain"
          disabled={busy}
          onClick={() => setConfirmDelete(false)}
          data-testid="studio-asset-cancel-delete-btn"
        >
          Keep asset
        </Button>
      )}
      {error && (
        <Alert size="sm" color="danger" data-testid="studio-asset-error">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

function StudioContent({ controller }: { controller?: StudioController }) {
  const [kind, setKind] = useState<StudioMediaKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const asset =
    controller?.state.status === 'ready' ? controller.state.assets.find(item => item.id === selected) : undefined;
  if (controller && kind)
    return (
      <CreationForm
        key={`${controller.sessionId}:${controller.workspaceId}:${controller.revision}:${kind}`}
        controller={controller}
        kind={kind}
        onBack={() => setKind(null)}
      />
    );
  if (controller && asset)
    return <AssetPreview key={asset.id} asset={asset} controller={controller} onBack={() => setSelected(null)} />;
  return (
    <Stack spacing={2}>
      <Box
        role="group"
        aria-label="Create media"
        data-testid="studio-creation-tiles"
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1 }}
      >
        {STUDIO_TILES.map(tile => {
          const capability = controller?.capabilities[tile.kind];
          const reason = !controller
            ? 'Studio is not connected yet.'
            : !capability
              ? 'Not supported.'
              : capability.status !== 'available'
                ? capability.reason
                : controller.busy
                  ? 'Studio is busy.'
                  : null;
          return (
            <Box key={tile.kind}>
              <Button
                fullWidth
                size="sm"
                variant="soft"
                color="neutral"
                startDecorator={tile.icon}
                disabled={!!reason}
                onClick={() => setKind(tile.kind)}
                aria-describedby={reason ? `studio-${tile.kind}-reason` : undefined}
                data-testid={`studio-create-${tile.kind}-tile`}
                sx={{ minHeight: 60, justifyContent: 'flex-start' }}
              >
                {tile.label}
              </Button>
              {reason && (
                <Typography
                  id={`studio-${tile.kind}-reason`}
                  level="body-xs"
                  textColor="text.tertiary"
                  sx={{ mt: 0.5 }}
                >
                  {reason}
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
      <Divider />
      <Typography level="title-sm">Assets and jobs</Typography>
      {!controller && (
        <Typography level="body-sm" data-testid="studio-unavailable">
          Studio workspace services are not connected. Creation and saved assets will appear here when available.
        </Typography>
      )}
      {controller?.state.status === 'loading' && (
        <Typography role="status" level="body-sm" data-testid="studio-loading">
          Loading Studio...
        </Typography>
      )}
      {controller?.state.status === 'error' && (
        <Alert size="sm" color="danger" data-testid="studio-load-error">
          {controller.state.error}
        </Alert>
      )}
      {controller?.state.status === 'ready' &&
        (() => {
          const assets = controller.state.assets;
          const assetIds = new Set(assets.map(asset => asset.id));
          const deliveredJobIds = new Set(assets.flatMap(asset => (asset.jobId ? [asset.jobId] : [])));
          const rows = [
            ...assets.map(item => ({ type: 'asset' as const, item })),
            ...controller.state.jobs
              .filter(job => !deliveredJobIds.has(job.id) && !job.assetIds.some(id => assetIds.has(id)))
              .map(item => ({ type: 'job' as const, item })),
          ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
          return rows.length === 0 ? (
            <Typography level="body-sm" textColor="text.tertiary" data-testid="studio-empty">
              No assets yet. Choose a tile above to create something with your session context.
            </Typography>
          ) : (
            <Stack component="ul" spacing={1} sx={{ p: 0, m: 0, listStyle: 'none' }} data-testid="studio-asset-list">
              {rows.map(row => (
                <Box component="li" key={`${row.type}-${row.item.id}`}>
                  {row.type === 'asset' ? (
                    <Button
                      fullWidth
                      variant="outlined"
                      color="neutral"
                      onClick={() => setSelected(row.item.id)}
                      data-testid={`studio-asset-${row.item.id}-btn`}
                      sx={{ justifyContent: 'flex-start', textAlign: 'left', minWidth: 0 }}
                    >
                      <Box sx={{ minWidth: 0 }}>
                        <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }}>
                          {row.item.title}
                        </Typography>
                        <Typography level="body-xs">
                          {mediaLabel(row.item.kind)} - {row.item.createdAt}
                        </Typography>
                      </Box>
                    </Button>
                  ) : (
                    <Box
                      data-testid={`studio-job-${row.item.id}`}
                      sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 'sm', p: 1 }}
                    >
                      <Typography level="body-sm">
                        {mediaLabel(row.item.kind)} - {row.item.state}
                      </Typography>
                      {row.item.error && (
                        <Typography level="body-xs" color="danger">
                          {row.item.error}
                        </Typography>
                      )}
                    </Box>
                  )}
                </Box>
              ))}
            </Stack>
          );
        })()}
    </Stack>
  );
}

export function StudioPane({
  controller,
  variant,
  onClose,
}: {
  controller?: StudioController;
  variant: 'docked' | 'drawer';
  onClose: () => void;
}) {
  const drawerHost = useRef<HTMLDivElement>(null);
  const content = (
    <>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ p: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="studio-pane-title" level="title-md">
            Studio
          </Typography>
          <Typography level="body-xs" noWrap>
            {controller?.familyLabel ?? 'Shared with your session family'}
          </Typography>
        </Box>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Close Studio"
          onClick={onClose}
          data-testid="studio-close-btn"
        >
          <CloseIcon />
        </IconButton>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5, ...thinScrollbarSx }}>
        <StudioContent
          key={`${controller?.sessionId ?? ''}:${controller?.workspaceId ?? ''}`}
          controller={controller}
        />
      </Box>
    </>
  );
  if (variant === 'drawer')
    return (
      <Box ref={drawerHost} sx={{ position: 'absolute', inset: 0, zIndex: 'modal' }}>
        <Modal
          open
          disablePortal
          container={() => drawerHost.current!}
          onClose={onClose}
          sx={{ position: 'absolute' }}
          slotProps={{ backdrop: { sx: { position: 'absolute' } } }}
        >
          <ModalDialog
            aria-labelledby="studio-pane-title"
            data-testid="studio-pane"
            data-variant="drawer"
            sx={{
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              left: 'auto',
              transform: 'none',
              width: STUDIO_PANE_WIDTH,
              maxWidth: '100%',
              maxHeight: '100%',
              p: 0,
              gap: 0,
              borderRadius: 0,
            }}
          >
            {content}
          </ModalDialog>
        </Modal>
      </Box>
    );
  return (
    <Box
      component="aside"
      aria-labelledby="studio-pane-title"
      data-testid="studio-pane"
      data-variant="docked"
      sx={{
        width: STUDIO_PANE_WIDTH,
        flexShrink: 0,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.surface',
      }}
    >
      {content}
    </Box>
  );
}

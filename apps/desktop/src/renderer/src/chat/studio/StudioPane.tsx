import { useEffect, useRef, useState, type ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Textarea from '@mui/joy/Textarea';
import Typography from '@mui/joy/Typography';
import type { StudioAsset, StudioMediaKind } from '@shared/studio';
import { studioAssetTitle } from '@shared/studioAssetTitle';
import { ArrowLeftIcon, CloseIcon, ImageIcon, MusicIcon, SoundIcon, VideoIcon, VoiceIcon } from '../icons';
import { thinScrollbarSx } from '../layout';
import { GenerationPayerNote } from '../../credits/GenerationPayerNote';
import type { StudioController, StudioCreationDraft } from './controller';
import { STUDIO_PANE_WIDTH } from './layout';
import { StudioSettings, defaultStudioSettings } from './StudioSettings';

export const STUDIO_TILES: readonly { kind: StudioMediaKind; label: string; icon: ReactNode; accent: string }[] = [
  { kind: 'image', label: 'Image', icon: <ImageIcon />, accent: 'primary' },
  { kind: 'video', label: 'Video', icon: <VideoIcon />, accent: 'warning' },
  { kind: 'music', label: 'Music', icon: <MusicIcon />, accent: 'success' },
  { kind: 'speech', label: 'Voice', icon: <VoiceIcon />, accent: 'primary' },
  { kind: 'sound-effect', label: 'Sound FX', icon: <SoundIcon />, accent: 'danger' },
];

export const mediaLabel = (kind: StudioMediaKind) => STUDIO_TILES.find(tile => tile.kind === kind)?.label ?? kind;
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
  initial,
}: {
  controller: StudioController;
  kind: StudioMediaKind;
  onBack: () => void;
  initial?: StudioAsset['creation'];
}) {
  const [storedDraft, setDraft] = useState<StudioCreationDraft>(() => ({
    sessionId: controller.sessionId,
    workspaceId: controller.workspaceId,
    revision: controller.revision,
    kind,
    prompt: initial?.prompt ?? '',
    selection: initial ? (initial.selection ?? { mode: 'none' }) : { mode: 'current-session' },
    settings: initial?.settings ?? defaultStudioSettings(kind, controller),
  }));
  const draft = { ...storedDraft, revision: controller.revision };
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'creating'>('idle');
  const [contextNotice, setContextNotice] = useState<string | null>(null);
  const operation = useRef<number | null>(null);
  const mounted = useRef(true);
  const knownRevision = useRef(controller.revision);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  const capability = controller.capabilities[kind];
  const locked = !!controller.busy || phase !== 'idle' || capability?.status !== 'available';
  const latest = useRef(controller);
  latest.current = controller;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    if (operation.current === null) setPhase('idle');
  }, [controller.busy, capability?.status]);
  useEffect(() => {
    if (knownRevision.current === controller.revision) return;
    knownRevision.current = controller.revision;
    epoch.current++;
    setContextNotice('Studio context changed. Your draft is kept. Review your settings before continuing.');
  }, [controller.revision]);

  const edit = (next: StudioCreationDraft) => {
    epoch.current++;
    setDraft(next);
    setError(null);
    setPhase('idle');
  };
  const generate = async () => {
    if (operation.current !== null || locked || !form.current?.reportValidity()) return;
    const request = ++epoch.current;
    operation.current = request;
    const snapshot = draft;
    const current = () =>
      mounted.current &&
      request === epoch.current &&
      latest.current.revision === snapshot.revision &&
      !latest.current.busy &&
      latest.current.capabilities[kind]?.status === 'available';
    let stage: 'preparing' | 'creating' = 'preparing';
    setPhase('preparing');
    setError(null);
    setContextNotice(null);
    try {
      const result = await controller.prepareCreation(snapshot);
      if (!current()) return;
      stage = 'creating';
      setPhase('creating');
      await controller.create({ draft: snapshot, reviewId: result.id, preparedPrompt: result.preparedPrompt });
      if (current()) onBack();
      else if (mounted.current && operation.current === request)
        setContextNotice('Your draft is kept; check Your creations for the request status before starting another.');
    } catch (cause) {
      if (mounted.current && operation.current === request && (stage === 'creating' || current()))
        setError(
          stage === 'preparing'
            ? `Studio could not prepare the prompt using this conversation's chat model. ${errorText(cause)}`
            : errorText(cause)
        );
    } finally {
      if (operation.current === request) {
        operation.current = null;
        if (mounted.current) setPhase('idle');
      }
    }
  };
  return (
    <Stack
      component="form"
      ref={form}
      onSubmit={event => event.preventDefault()}
      spacing={2}
      data-testid="studio-creation-form"
    >
      {contextNotice && (
        <Alert size="sm" color="neutral" data-testid="studio-context-changed">
          {contextNotice}
        </Alert>
      )}
      <StudioSettings controller={controller} draft={draft} disabled={locked} edit={edit} />
      <FormControl disabled={locked}>
        <FormLabel>{kind === 'speech' ? 'Script or instructions' : 'What would you like to create?'}</FormLabel>
        <Textarea
          minRows={5}
          value={draft.prompt}
          onChange={event => edit({ ...draft, prompt: event.target.value })}
          slotProps={{ textarea: { 'data-testid': 'studio-prompt-input' } }}
        />
      </FormControl>
      <Checkbox
        size="sm"
        label="Use current session context"
        disabled={locked}
        checked={draft.selection.mode === 'current-session'}
        onChange={event => edit({ ...draft, selection: { mode: event.target.checked ? 'current-session' : 'none' } })}
        slotProps={{ input: { 'data-testid': 'studio-use-session-context-checkbox' } }}
      />
      <Typography level="body-xs" textColor="text.tertiary">
        Studio prepares prompts using this conversation's chat model, even when session context is off.
      </Typography>
      {!controller.catalog &&
        capability?.status === 'available' &&
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
                  value={typeof value === 'number' || typeof value === 'string' ? value : ''}
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
        variant="outlined"
        color="neutral"
        sx={{ '&.Mui-disabled': { borderColor: 'neutral.outlinedBorder' } }}
        disabled={locked || !draft.prompt.trim()}
        loading={phase !== 'idle'}
        onClick={() => void generate()}
        data-testid="studio-generate-btn"
      >
        Generate
      </Button>
      <GenerationPayerNote data-testid="studio-payer-note" />
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
  const [title, setTitle] = useState(() => studioAssetTitle(asset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const locked = busy || !!controller.busy;
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
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        onClick={onBack}
        disabled={busy}
        data-testid="studio-preview-back-btn"
        aria-label="Back to Studio"
        sx={{ alignSelf: 'flex-start' }}
      >
        <ArrowLeftIcon />
      </IconButton>
      <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }}>
        {studioAssetTitle(asset)}
      </Typography>
      {mediaFailed || !asset.url ? (
        <Alert size="sm" color="neutral" data-testid="studio-asset-media-error">
          Preview unavailable. You can still export this asset.
        </Alert>
      ) : asset.kind === 'image' ? (
        <Box
          component="img"
          src={asset.url}
          alt={studioAssetTitle(asset)}
          onError={() => setMediaFailed(true)}
          data-testid="studio-asset-image"
          sx={{ display: 'block', width: '100%', maxHeight: '45vh', objectFit: 'contain', borderRadius: 'sm' }}
        />
      ) : asset.kind === 'video' ? (
        <Box
          component="video"
          src={asset.url}
          controls
          onError={() => setMediaFailed(true)}
          sx={{ width: '100%', maxHeight: '45vh', borderRadius: 'sm' }}
        />
      ) : (
        <Box component="audio" src={asset.url} controls onError={() => setMediaFailed(true)} sx={{ width: '100%' }} />
      )}
      <Stack direction="row" spacing={1} alignItems="center" data-testid="studio-asset-actions">
        <Box role="group" aria-label="Asset actions" sx={{ display: 'inline-flex', flexShrink: 0 }}>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            sx={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
            disabled={locked || !controller.exportAsset || !!controller.assetActionReasons?.export}
            data-testid="studio-asset-export-btn"
            onClick={() => void run(() => controller.exportAsset!(asset))}
          >
            Export
          </Button>
          <Dropdown>
            <MenuButton
              size="sm"
              variant="outlined"
              color="neutral"
              disabled={locked}
              aria-label="More asset actions"
              data-testid="studio-asset-actions-btn"
              sx={{ ml: '-1px', minWidth: 28, px: 0.75, borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }}
            >
              <Box component="svg" viewBox="0 0 16 16" aria-hidden="true" sx={{ width: 14, height: 14 }}>
                <path
                  d="m4 6 4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Box>
            </MenuButton>
            <Menu placement="bottom-end">
              <MenuItem
                disabled={!controller.renameAsset || !!controller.assetActionReasons?.rename}
                data-testid="studio-asset-rename-btn"
                onClick={() => {
                  setRenaming(true);
                  setConfirmDelete(false);
                }}
              >
                Rename
              </MenuItem>
              <MenuItem
                disabled={!asset.creation || !controller.reuseAsset || !!controller.assetActionReasons?.reuse}
                data-testid="studio-asset-reuse-btn"
                onClick={() => void run(() => controller.reuseAsset!(asset))}
              >
                Use settings again
              </MenuItem>
              <MenuItem
                color="danger"
                disabled={!controller.deleteAsset || !!controller.assetActionReasons?.delete}
                data-testid="studio-asset-delete-btn"
                onClick={() => {
                  setConfirmDelete(true);
                  setRenaming(false);
                }}
              >
                Delete
              </MenuItem>
            </Menu>
          </Dropdown>
        </Box>
        {asset.prompt && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            aria-expanded={showPrompt}
            aria-controls="studio-asset-prompt"
            data-testid="studio-asset-toggle-prompt-btn"
            onClick={() => setShowPrompt(value => !value)}
            sx={{ px: 0.5, minWidth: 0, whiteSpace: 'nowrap', ml: 'auto !important' }}
          >
            {showPrompt ? 'Hide prompt' : 'Show prompt'}
          </Button>
        )}
      </Stack>
      {renaming && (
        <Stack
          component="form"
          direction="row"
          spacing={1}
          onSubmit={event => {
            event.preventDefault();
            if (title.trim() && !locked && controller.renameAsset)
              void run(async () => {
                await controller.renameAsset!(asset, title.trim());
                setRenaming(false);
              });
          }}
        >
          <Input
            value={title}
            disabled={locked}
            aria-label="Asset name"
            sx={{ flex: 1, minWidth: 0 }}
            onChange={event => setTitle(event.target.value)}
            slotProps={{ input: { 'data-testid': 'studio-asset-title-input' } }}
          />
          <Button type="submit" size="sm" disabled={locked || !title.trim()}>
            Save
          </Button>
          <Button size="sm" variant="outlined" color="neutral" disabled={locked} onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </Stack>
      )}
      {confirmDelete && (
        <Stack direction="row" spacing={1}>
          <Button
            size="sm"
            color="danger"
            disabled={locked || !controller.deleteAsset}
            data-testid="studio-asset-confirm-delete-btn"
            onClick={() => void run(() => controller.deleteAsset!(asset), true)}
          >
            Confirm delete
          </Button>
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            disabled={locked}
            onClick={() => setConfirmDelete(false)}
            data-testid="studio-asset-cancel-delete-btn"
          >
            Keep asset
          </Button>
        </Stack>
      )}
      {asset.prompt && showPrompt && (
        <Typography id="studio-asset-prompt" level="body-sm" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {asset.prompt}
        </Typography>
      )}
      {error && (
        <Alert size="sm" color="danger" data-testid="studio-asset-error">
          {error}
        </Alert>
      )}
    </Stack>
  );
}

/** Why a medium cannot be started right now, or null when it can. Shared with the Studio place's sidebar. */
export function tileUnavailableReason(
  controller: StudioController | undefined,
  kind: StudioMediaKind,
  unavailableReason?: string
): string | null {
  const capability = controller?.capabilities[kind];
  if (!controller) return unavailableReason ?? 'Studio is not connected yet.';
  if (!capability) return 'Not supported.';
  if (capability.status !== 'available') return capability.reason;
  return controller.busy ? 'Studio is busy.' : null;
}

/** The pane's body - the medium tiles, a creation form, or an asset preview - with the medium owned by the caller. */
export function StudioContent({
  controller,
  kind,
  setKind,
  unavailableReason,
}: {
  controller?: StudioController;
  kind: StudioMediaKind | null;
  setKind: (kind: StudioMediaKind | null) => void;
  unavailableReason?: string;
}) {
  const [initial, setInitial] = useState<StudioAsset['creation']>();
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const asset =
    controller?.state.status === 'ready' ? controller.state.assets.find(item => item.id === selected) : undefined;
  if (controller && kind)
    return (
      <CreationForm
        key={`${controller.sessionId}:${controller.workspaceId}:${kind}`}
        controller={controller}
        kind={kind}
        initial={initial}
        onBack={() => setKind(null)}
      />
    );
  if (controller && asset)
    return (
      <AssetPreview
        key={asset.id}
        asset={asset}
        controller={{
          ...controller,
          reuseAsset: async item => {
            if (!item.creation) throw new Error('Saved settings are unavailable for this legacy asset.');
            setInitial(item.creation);
            setKind(item.kind);
            setSelected(null);
          },
        }}
        onBack={() => setSelected(null)}
      />
    );
  return (
    <Stack spacing={2}>
      <Box
        role="group"
        aria-label="Create media"
        data-testid="studio-creation-tiles"
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1.25 }}
      >
        {STUDIO_TILES.map(tile => {
          const reason = tileUnavailableReason(controller, tile.kind, unavailableReason);
          return (
            <Box key={tile.kind}>
              <Button
                fullWidth
                size="sm"
                variant="outlined"
                color="neutral"
                startDecorator={
                  <Box
                    sx={{
                      display: 'flex',
                      p: 0.75,
                      borderRadius: 'sm',
                      color: `${tile.accent}.softColor`,
                      bgcolor: `${tile.accent}.softBg`,
                    }}
                  >
                    {tile.icon}
                  </Box>
                }
                disabled={!!reason}
                onClick={() => {
                  setInitial(undefined);
                  setKind(tile.kind);
                }}
                aria-describedby={reason ? `studio-${tile.kind}-reason` : undefined}
                data-testid={`studio-create-${tile.kind}-tile`}
                title={reason ?? `Create ${tile.label}`}
                sx={{
                  minHeight: 62,
                  px: 1.25,
                  gap: 1,
                  justifyContent: 'flex-start',
                  borderColor: 'divider',
                  borderRadius: 'md',
                  bgcolor: 'background.surface',
                  fontWeight: 500,
                  '&:hover': { borderColor: `${tile.accent}.outlinedBorder`, bgcolor: 'background.level1' },
                }}
              >
                {tile.label}
              </Button>
              {reason && (
                <Typography
                  id={`studio-${tile.kind}-reason`}
                  level="body-xs"
                  textColor="text.tertiary"
                  sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}
                >
                  {reason}
                </Typography>
              )}
            </Box>
          );
        })}
      </Box>
      <Divider />
      {(controller?.hasMoreAssets || controller?.hasMoreJobs) && (
        <Typography level="body-xs">Partial history loaded. Load remaining pages to browse all records.</Typography>
      )}
      {(['assets', 'jobs'] as const).map(
        collection =>
          (collection === 'assets' ? controller?.hasMoreAssets : controller?.hasMoreJobs) && (
            <Button
              key={collection}
              size="sm"
              disabled={paging}
              data-testid={`studio-load-more-${collection}-btn`}
              onClick={() => {
                setPaging(true);
                setPagingError(null);
                void controller
                  ?.loadMore?.(collection)
                  .catch(cause => setPagingError(errorText(cause)))
                  .finally(() => setPaging(false));
              }}
            >
              Load more {collection}
            </Button>
          )
      )}
      {pagingError && <Alert color="danger">{pagingError}</Alert>}
      {!controller && (
        <Typography level="body-sm" data-testid="studio-unavailable">
          {unavailableReason ??
            'Studio workspace services are not connected. Creation and saved assets will appear here when available.'}
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
              .filter(
                job =>
                  job.state !== 'completed' ||
                  !!job.error ||
                  (!deliveredJobIds.has(job.id) && !job.assetIds.some(id => assetIds.has(id)))
              )
              .map(item => ({ type: 'job' as const, item })),
          ].sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
          return rows.length === 0 ? (
            <Typography
              level="body-sm"
              textColor="text.tertiary"
              data-testid="studio-empty"
              sx={{ textAlign: 'center', py: 5 }}
            >
              Your creations will appear here.
            </Typography>
          ) : (
            <Stack component="ul" spacing={1} sx={{ p: 0, m: 0, listStyle: 'none' }} data-testid="studio-asset-list">
              {rows.map(row => (
                <Box component="li" key={`${row.type}-${row.item.id}`}>
                  {row.type === 'asset' ? (
                    <Button
                      fullWidth
                      variant="plain"
                      color="neutral"
                      onClick={() => setSelected(row.item.id)}
                      data-testid={`studio-asset-${row.item.id}-btn`}
                      sx={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        minWidth: 0,
                        gap: 1.5,
                        p: 1,
                        borderRadius: 'md',
                      }}
                    >
                      {row.item.kind === 'image' ? (
                        <Box
                          component="img"
                          src={row.item.url}
                          alt=""
                          sx={{
                            width: 44,
                            height: 44,
                            objectFit: 'cover',
                            borderRadius: 'sm',
                            bgcolor: 'background.level1',
                          }}
                        />
                      ) : (
                        <Box
                          sx={{
                            width: 44,
                            height: 44,
                            flexShrink: 0,
                            display: 'grid',
                            placeItems: 'center',
                            borderRadius: 'sm',
                            bgcolor: `${STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.accent ?? 'primary'}.softBg`,
                            color: `${STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.accent ?? 'primary'}.softColor`,
                          }}
                        >
                          {STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.icon}
                        </Box>
                      )}
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography
                          level="title-sm"
                          title={studioAssetTitle(row.item)}
                          sx={{
                            display: '-webkit-box',
                            WebkitBoxOrient: 'vertical',
                            WebkitLineClamp: 2,
                            overflow: 'hidden',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {studioAssetTitle(row.item)}
                        </Typography>
                        <Typography level="body-xs" textColor="text.tertiary" sx={{ opacity: 0.65 }}>
                          {new Date(row.item.createdAt).toLocaleDateString()}
                        </Typography>
                      </Box>
                    </Button>
                  ) : (
                    <Box
                      data-testid={`studio-job-${row.item.id}`}
                      sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1, py: 1, borderRadius: 'md' }}
                    >
                      <Box
                        aria-hidden="true"
                        sx={{
                          width: 44,
                          height: 44,
                          flexShrink: 0,
                          display: 'grid',
                          placeItems: 'center',
                          borderRadius: 'sm',
                          bgcolor: `${STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.accent ?? 'primary'}.softBg`,
                          color: `${STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.accent ?? 'primary'}.softColor`,
                          position: 'relative',
                          overflow: 'hidden',
                          ...(['submitting', 'queued', 'running'].includes(row.item.state) && {
                            '&::after': {
                              content: '""',
                              position: 'absolute',
                              inset: 0,
                              background:
                                'linear-gradient(110deg, transparent 20%, rgba(128,128,128,0.16) 50%, transparent 80%)',
                              animation: 'studio-job-shimmer 1.8s ease-in-out infinite',
                            },
                            '@keyframes studio-job-shimmer': {
                              from: { transform: 'translateX(-100%)' },
                              to: { transform: 'translateX(100%)' },
                            },
                            '@media (prefers-reduced-motion: reduce)': { '&::after': { animation: 'none' } },
                          }),
                        }}
                      >
                        {STUDIO_TILES.find(tile => tile.kind === row.item.kind)?.icon}
                      </Box>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Typography level="title-sm" noWrap>
                          {mediaLabel(row.item.kind)}
                        </Typography>
                        <Typography
                          level="body-xs"
                          textColor="text.tertiary"
                          noWrap
                          title={row.item.error ?? undefined}
                        >
                          {row.item.error ??
                            {
                              submitting: 'Starting...',
                              queued: 'Queued',
                              running: 'Creating...',
                              completed: 'Completed',
                              failed: 'Failed',
                              cancelled: 'Cancelled',
                              unknown: 'Status unavailable',
                            }[row.item.state]}
                        </Typography>
                      </Box>
                      {controller.jobAction && !['completed', 'failed', 'cancelled'].includes(row.item.state) && (
                        <Dropdown>
                          <MenuButton
                            size="sm"
                            variant="plain"
                            aria-label="Generation actions"
                            sx={{ minWidth: 28, px: 0.75, flexShrink: 0 }}
                          >
                            {'\u22ef'}
                          </MenuButton>
                          <Menu placement="bottom-end">
                            <MenuItem
                              data-testid={`studio-job-${row.item.id}-recheck-btn`}
                              onClick={() =>
                                void controller.jobAction!(row.item.id, 'recheck').catch(cause =>
                                  setPagingError(errorText(cause))
                                )
                              }
                            >
                              Recheck status
                            </MenuItem>
                            {['video', 'music'].includes(row.item.kind) && row.item.providerJobId && (
                              <MenuItem
                                color="danger"
                                data-testid={`studio-job-${row.item.id}-cancel-btn`}
                                onClick={() =>
                                  void controller.jobAction!(row.item.id, 'cancel').catch(cause =>
                                    setPagingError(errorText(cause))
                                  )
                                }
                              >
                                Cancel job
                              </MenuItem>
                            )}
                          </Menu>
                        </Dropdown>
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
  unavailableReason,
}: {
  controller?: StudioController;
  variant: 'docked' | 'stacked';
  onClose: () => void;
  unavailableReason?: string;
}) {
  const [creation, setCreation] = useState<{ sessionId: string; workspaceId: string; kind: StudioMediaKind } | null>(
    null
  );
  const kind =
    creation?.sessionId === controller?.sessionId && creation?.workspaceId === controller?.workspaceId
      ? (creation?.kind ?? null)
      : null;
  const setKind = (next: StudioMediaKind | null) => {
    setCreation(
      next && controller ? { sessionId: controller.sessionId, workspaceId: controller.workspaceId, kind: next } : null
    );
  };
  const content = (
    <>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 1.5, py: 1.25, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {kind && (
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Back to Studio"
            disabled={controller?.busy}
            onClick={() => setKind(null)}
            data-testid="studio-creation-back-btn"
          >
            <ArrowLeftIcon />
          </IconButton>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id="studio-pane-title" level="title-md">
            {kind ? `Create ${mediaLabel(kind)}` : 'Studio'}
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
          kind={kind}
          setKind={setKind}
          unavailableReason={unavailableReason}
        />
      </Box>
    </>
  );
  return (
    <Box
      component="aside"
      aria-labelledby="studio-pane-title"
      data-testid="studio-pane"
      data-variant={variant}
      onKeyDown={event => {
        if (event.key === 'Escape' && !event.defaultPrevented) onClose();
      }}
      sx={{
        width: variant === 'stacked' ? '100%' : STUDIO_PANE_WIDTH,
        height: variant === 'stacked' ? '50%' : undefined,
        flexShrink: 0,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: variant === 'docked' ? '1px solid' : undefined,
        borderTop: variant === 'stacked' ? '1px solid' : undefined,
        borderColor: 'divider',
        bgcolor: 'background.surface',
      }}
    >
      {content}
    </Box>
  );
}

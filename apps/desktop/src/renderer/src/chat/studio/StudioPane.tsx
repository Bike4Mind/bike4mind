import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
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
import { ArrowLeftIcon, CloseIcon } from '../icons';
import { thinScrollbarSx } from '../layout';
import { GenerationPayerNote } from '../../credits/GenerationPayerNote';
import type { StudioController, StudioCreationDraft } from './controller';
import { STUDIO_PANE_WIDTH } from './layout';
import { StudioScope } from './design/StudioScope';
import {
  studioColor,
  studioFocusSx,
  studioMicroLabelSx,
  studioPanelSx,
  studioRadius,
  studioTransitionSx,
} from './design/studioTokens';
import { mediaLabel, STUDIO_MEDIA, studioMedium } from './media';
import { AssetTake, JobTake, TakesEmpty, TakesGrid, TakesHeading } from './StudioTakes';
import { StudioSettings, defaultStudioSettings } from './StudioSettings';

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
  layout,
}: {
  controller: StudioController;
  kind: StudioMediaKind;
  onBack: () => void;
  initial?: StudioAsset['creation'];
  layout: StudioLayout;
}) {
  // The rail's Studio place has no conversation, so it never offers the session-context toggle.
  const inPlace = layout === 'place';
  const [storedDraft, setDraft] = useState<StudioCreationDraft>(() => ({
    sessionId: controller.sessionId,
    workspaceId: controller.workspaceId,
    revision: controller.revision,
    kind,
    prompt: initial?.prompt ?? '',
    selection: inPlace
      ? { mode: 'none' }
      : initial
        ? (initial.selection ?? { mode: 'none' })
        : { mode: 'current-session' },
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
      // The place keeps the form up, as web Create does: the new take lands in the gallery below it.
      if (current()) {
        if (!inPlace) onBack();
      } else if (mounted.current && operation.current === request)
        setContextNotice('Your draft is kept; check Your creations for the request status before starting another.');
    } catch (cause) {
      if (mounted.current && operation.current === request && (stage === 'creating' || current()))
        setError(
          stage === 'preparing'
            ? `Studio could not prepare the prompt${inPlace ? '' : " using this conversation's chat model"}. ${errorText(cause)}`
            : errorText(cause)
        );
    } finally {
      if (operation.current === request) {
        operation.current = null;
        if (mounted.current) setPhase('idle');
      }
    }
  };
  const formSx = {
    // StudioSettings draws its own fields; this gives them web Studio's label and control styling.
    '& .MuiFormLabel-root': studioMicroLabelSx,
    '& select': {
      minHeight: 34,
      fontSize: '13px',
      bgcolor: studioColor('raised'),
      borderColor: studioColor('border'),
      borderRadius: studioRadius('md'),
      color: studioColor('text'),
    },
  } as const;
  const contextChanged = contextNotice && (
    <Alert size="sm" color="neutral" data-testid="studio-context-changed">
      {contextNotice}
    </Alert>
  );
  const prompt = (
    <FormControl disabled={locked}>
      <FormLabel>{kind === 'speech' ? 'Script or instructions' : 'What would you like to create?'}</FormLabel>
      <Textarea
        minRows={5}
        sx={{ bgcolor: studioColor('sunken'), borderColor: studioColor('border'), borderRadius: studioRadius('md') }}
        value={draft.prompt}
        onChange={event => edit({ ...draft, prompt: event.target.value })}
        slotProps={{ textarea: { 'data-testid': 'studio-prompt-input' } }}
      />
    </FormControl>
  );
  const sessionContext = (
    <>
      <Checkbox
        size="sm"
        label="Use current session context"
        disabled={locked}
        checked={draft.selection.mode === 'current-session'}
        onChange={event => edit({ ...draft, selection: { mode: event.target.checked ? 'current-session' : 'none' } })}
        slotProps={{ input: { 'data-testid': 'studio-use-session-context-checkbox' } }}
      />
      <Typography level="body-xs" sx={{ color: studioColor('text-muted'), mt: '4px !important' }}>
        Studio prepares prompts using this conversation's chat model, even when session context is off.
      </Typography>
    </>
  );
  const legacyFields =
    !controller.catalog &&
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
    });
  const unsupported = capability?.status !== 'available' && (
    <Alert size="sm" color="neutral">
      {capability?.reason ?? 'This media type is not supported.'}
    </Alert>
  );
  const action = (
    <>
      <Button
        variant="solid"
        color="primary"
        sx={{
          borderRadius: studioRadius('md'),
          fontWeight: 600,
          '&:active:not(.Mui-disabled)': { transform: 'translateY(1px)' },
        }}
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
    </>
  );

  if (inPlace)
    // Web Create's split: the prompt and options in the main panel, the model and the action in a side panel.
    return (
      <Box
        component="form"
        ref={form}
        onSubmit={event => event.preventDefault()}
        data-testid="studio-creation-form"
        sx={{
          ...formSx,
          display: 'grid',
          gap: 2,
          alignItems: 'start',
          gridTemplateColumns: 'minmax(0, 1fr)',
          '@container studio-main (min-width: 720px)': { gridTemplateColumns: 'minmax(0, 1fr) 300px' },
        }}
      >
        <Stack spacing={2} sx={{ ...studioPanelSx, p: 2, minWidth: 0 }} data-testid="studio-creation-main-panel">
          {contextChanged}
          {prompt}
          <StudioSettings controller={controller} draft={draft} disabled={locked} edit={edit} part="options" />
          {legacyFields}
          {unsupported}
        </Stack>
        <Stack spacing={2} sx={{ ...studioPanelSx, p: 2, minWidth: 0 }} data-testid="studio-creation-side-panel">
          <StudioSettings controller={controller} draft={draft} disabled={locked} edit={edit} part="model" />
          {action}
        </Stack>
      </Box>
    );

  return (
    <Stack
      component="form"
      ref={form}
      onSubmit={event => event.preventDefault()}
      spacing={2}
      data-testid="studio-creation-form"
      sx={{ ...studioPanelSx, p: 2, ...formSx }}
    >
      {contextChanged}
      <StudioSettings controller={controller} draft={draft} disabled={locked} edit={edit} />
      {prompt}
      {sessionContext}
      {legacyFields}
      {unsupported}
      {action}
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

export type StudioLayout = 'pane' | 'place';

/**
 * The takes under the tiles or the form: the saved assets and the jobs still worth showing, newest first, with
 * paging and load states. `kind` narrows them to one medium, as web Create's gallery does under its form.
 */
function StudioTakesSection({
  controller,
  kind,
  unavailableReason,
  onOpen,
}: {
  controller?: StudioController;
  kind?: StudioMediaKind;
  unavailableReason?: string;
  onOpen: (assetId: string) => void;
}) {
  const [pagingError, setPagingError] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const medium = kind ? studioMedium(kind) : undefined;
  return (
    <>
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
          ]
            .filter(row => !kind || row.item.kind === kind)
            .sort((a, b) => b.item.createdAt.localeCompare(a.item.createdAt));
          return (
            <Stack spacing={1.25} data-testid="studio-takes">
              <TakesHeading count={rows.length} title={medium?.galleryTitle} />
              {rows.length === 0 ? (
                <TakesEmpty kind={kind} />
              ) : (
                <TakesGrid>
                  {rows.map(row =>
                    row.type === 'asset' ? (
                      <AssetTake key={`asset-${row.item.id}`} asset={row.item} onOpen={() => onOpen(row.item.id)} />
                    ) : (
                      <JobTake
                        key={`job-${row.item.id}`}
                        job={row.item}
                        onAction={
                          controller.jobAction
                            ? action =>
                                void controller.jobAction!(row.item.id, action).catch(cause =>
                                  setPagingError(errorText(cause))
                                )
                            : undefined
                        }
                      />
                    )
                  )}
                </TakesGrid>
              )}
            </Stack>
          );
        })()}
    </>
  );
}

/**
 * Studio's body with the medium owned by the caller. In the per-conversation pane: the medium tiles over the takes,
 * a creation form, or an asset preview. In the rail's Studio place (`layout="place"`), web Create's shape: the
 * medium's form with that medium's takes under it, or an asset preview.
 */
export function StudioContent({
  controller,
  kind,
  setKind,
  unavailableReason,
  layout = 'pane',
}: {
  controller?: StudioController;
  kind: StudioMediaKind | null;
  setKind: (kind: StudioMediaKind | null) => void;
  unavailableReason?: string;
  layout?: StudioLayout;
}) {
  // `reuse` counts Reuse clicks, so reusing a second take of the same medium still refills the form.
  const [initial, setInitial] = useState<{ kind: StudioMediaKind; creation: StudioAsset['creation']; reuse: number }>();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (layout === 'place' && initial && initial.kind !== kind) setInitial(undefined);
  }, [layout, kind, initial]);
  useEffect(() => {
    if (layout === 'place') setSelected(null);
  }, [layout, kind]);
  const asset =
    controller?.state.status === 'ready' ? controller.state.assets.find(item => item.id === selected) : undefined;
  const preview = controller && asset && (
    <AssetPreview
      key={asset.id}
      asset={asset}
      controller={{
        ...controller,
        reuseAsset: async item => {
          if (!item.creation) throw new Error('Saved settings are unavailable for this legacy asset.');
          setInitial(current => ({ kind: item.kind, creation: item.creation, reuse: (current?.reuse ?? 0) + 1 }));
          setKind(item.kind);
          setSelected(null);
        },
      }}
      onBack={() => setSelected(null)}
    />
  );

  if (layout === 'place') {
    return (
      <>
        {preview}
        <Stack spacing={2.5} sx={preview ? { display: 'none' } : undefined}>
          {controller && kind && (
            <CreationForm
              key={`${controller.sessionId}:${controller.workspaceId}:${kind}:${initial?.reuse ?? 0}`}
              controller={controller}
              kind={kind}
              initial={initial?.kind === kind ? initial.creation : undefined}
              onBack={() => setKind(null)}
              layout="place"
            />
          )}
          <StudioTakesSection
            controller={controller}
            kind={kind ?? undefined}
            unavailableReason={unavailableReason}
            onOpen={setSelected}
          />
        </Stack>
      </>
    );
  }

  if (controller && kind)
    return (
      <CreationForm
        key={`${controller.sessionId}:${controller.workspaceId}:${kind}`}
        controller={controller}
        kind={kind}
        initial={initial?.creation}
        onBack={() => setKind(null)}
        layout="pane"
      />
    );
  if (preview) return preview;
  return (
    <Stack spacing={2}>
      <Box
        role="group"
        aria-label="Create media"
        data-testid="studio-creation-tiles"
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: 1.25 }}
      >
        {STUDIO_MEDIA.map(medium => {
          const reason = tileUnavailableReason(controller, medium.kind, unavailableReason);
          return (
            <Box key={medium.kind} sx={{ minWidth: 0 }}>
              <Box
                component="button"
                type="button"
                disabled={!!reason}
                onClick={() => {
                  setInitial(undefined);
                  setKind(medium.kind);
                }}
                aria-describedby={reason ? `studio-${medium.kind}-reason` : undefined}
                data-testid={`studio-create-${medium.kind}-tile`}
                title={reason ?? `Create ${medium.label}`}
                sx={{
                  ...studioPanelSx,
                  ...studioTransitionSx,
                  ...studioFocusSx,
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 1,
                  p: 1.5,
                  font: 'inherit',
                  textAlign: 'left',
                  color: studioColor('text'),
                  cursor: 'pointer',
                  '& .studio-medium-glyph': {
                    ...studioTransitionSx,
                    display: 'grid',
                    placeItems: 'center',
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    borderRadius: studioRadius('md'),
                    bgcolor: studioColor('raised'),
                    border: `1px solid ${studioColor('hairline')}`,
                    color: studioColor('text-secondary'),
                  },
                  '&:hover:not(:disabled)': {
                    borderColor: studioColor('accent-border'),
                    bgcolor: studioColor('hover'),
                    '& .studio-medium-glyph': {
                      bgcolor: studioColor('accent'),
                      borderColor: studioColor('accent'),
                      color: studioColor('accent-contrast'),
                    },
                  },
                  '&:disabled': { cursor: 'default', opacity: 0.55 },
                }}
              >
                <span className="studio-medium-glyph">{medium.icon}</span>
                <Box component="span" sx={{ minWidth: 0 }}>
                  <Typography level="title-sm" sx={{ color: studioColor('text-strong') }}>
                    {medium.label}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: studioColor('text-muted') }}>
                    {medium.hint}
                  </Typography>
                </Box>
              </Box>
              {reason && (
                <Typography
                  id={`studio-${medium.kind}-reason`}
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
      <StudioTakesSection controller={controller} unavailableReason={unavailableReason} onOpen={setSelected} />
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
        sx={{ px: 1.5, py: 1.25, borderBottom: `1px solid ${studioColor('hairline')}` }}
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
          <Typography
            id="studio-pane-title"
            level="title-md"
            sx={{ color: studioColor('text-strong'), fontWeight: 700 }}
          >
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
      }}
    >
      <StudioScope sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{content}</StudioScope>
    </Box>
  );
}

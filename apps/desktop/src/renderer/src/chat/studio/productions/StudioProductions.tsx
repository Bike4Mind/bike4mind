import { useEffect, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import CircularProgress from '@mui/joy/CircularProgress';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import LinearProgress from '@mui/joy/LinearProgress';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS, type GenerationJobState } from '@bike4mind/common';
import {
  isRenderInFlight,
  type ProductionDetail,
  type ProductionRenderJob,
  type ProductionsApi,
  type ProductionSummary,
  type ProductionVideoTrack,
} from '@shared/productions';
import { useAuthState } from '../../../auth/useAuthState';
import { ArrowLeftIcon, ArrowUpIcon } from '../../icons';
import { studioColor, studioFocusSx, studioMicroLabelSx, studioPanelSx, studioRadius } from '../design/studioTokens';
import { useProduction, useProductionList, useRenderMedia, type ProductionsError } from './useProductions';
import { useRenderJobs } from './useRenderJobs';

const STATE_LABEL: Record<GenerationJobState, string> = {
  pending: 'Queued',
  running: 'Rendering',
  storing: 'Saving',
  succeeded: 'Ready',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};

const STATE_TONE: Partial<Record<GenerationJobState, 'success' | 'danger' | 'accent'>> = {
  succeeded: 'success',
  failed: 'danger',
  blocked: 'danger',
  running: 'accent',
  storing: 'accent',
};

const templateLabel = (template: ProductionSummary['template']) =>
  STUDIO_COMPOSITION_TEMPLATE_DEFINITIONS[template]?.label ?? template;

export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;

const formatUpdated = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function CenteredState({
  title,
  body,
  action,
  testId,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  testId: string;
}) {
  return (
    <Stack
      spacing={0.75}
      sx={{
        maxWidth: 460,
        mx: 'auto',
        mt: 10,
        px: 3,
        py: 4,
        textAlign: 'center',
        alignItems: 'center',
        border: `1px dashed ${studioColor('border')}`,
        borderRadius: studioRadius('lg'),
      }}
      data-testid={testId}
    >
      <Typography level="title-md" sx={{ color: studioColor('text-strong') }}>
        {title}
      </Typography>
      <Typography level="body-sm" sx={{ color: studioColor('text-secondary') }}>
        {body}
      </Typography>
      {action}
    </Stack>
  );
}

/** The gate, sign-in and not-found answers each get their own state; anything else is a retryable error. */
function ErrorState({
  error,
  onRetry,
  testIdPrefix,
}: {
  error: ProductionsError;
  onRetry: () => void;
  testIdPrefix: string;
}) {
  if (error.kind === 'not-enabled') {
    return (
      <CenteredState
        title="Productions is not enabled for your account"
        body="Productions is rolling out gradually. Once it is turned on for your account, your productions show up here and on the web."
        testId="studio-productions-not-enabled"
      />
    );
  }
  return (
    <CenteredState
      title={
        error.kind === 'signed-out'
          ? 'Sign in to see Productions'
          : error.kind === 'not-found'
            ? 'Production not found'
            : 'Could not load Productions'
      }
      body={error.message}
      action={
        error.kind === 'failed' ? (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={onRetry}
            data-testid={`${testIdPrefix}-retry-btn`}
          >
            Try again
          </Button>
        ) : undefined
      }
      testId={`${testIdPrefix}-error`}
    />
  );
}

function ProductionRow({ item, onOpen }: { item: ProductionSummary; onOpen: () => void }) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onOpen}
      sx={{
        ...studioFocusSx,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        width: '100%',
        textAlign: 'left',
        font: 'inherit',
        cursor: 'pointer',
        px: 2,
        py: 1.5,
        border: 0,
        borderBottom: `1px solid ${studioColor('hairline')}`,
        bgcolor: 'transparent',
        color: studioColor('text'),
        '&:last-of-type': { borderBottom: 0 },
        '&:hover': { bgcolor: studioColor('hover') },
      }}
      data-testid={`studio-productions-row-${item.id}`}
    >
      <Stack sx={{ flex: 1, minWidth: 0 }}>
        <Typography level="title-sm" noWrap sx={{ color: studioColor('text-strong') }}>
          {item.title}
        </Typography>
        <Typography level="body-xs" sx={{ color: studioColor('text-muted') }}>
          {templateLabel(item.template)}
        </Typography>
      </Stack>
      <Typography level="body-xs" sx={{ color: studioColor('text-muted'), flexShrink: 0 }}>
        Updated {formatUpdated(item.updatedAt)}
      </Typography>
    </Box>
  );
}

function ProductionsList({
  list,
  onOpen,
}: {
  list: ReturnType<typeof useProductionList>;
  onOpen: (id: string) => void;
}) {
  if (list.error && list.items.length === 0) {
    return <ErrorState error={list.error} onRetry={list.refresh} testIdPrefix="studio-productions" />;
  }
  if (list.loading && list.items.length === 0) {
    return (
      <Stack alignItems="center" sx={{ mt: 10 }} data-testid="studio-productions-loading">
        <CircularProgress size="sm" />
      </Stack>
    );
  }
  return (
    <Stack spacing={2} sx={{ maxWidth: 960, mx: 'auto' }} data-testid="studio-productions-list">
      <Stack spacing={0.5}>
        <Typography level="title-lg" sx={{ color: studioColor('text-strong'), fontWeight: 700 }}>
          Productions
        </Typography>
        <Typography level="body-sm" sx={{ color: studioColor('text-secondary') }}>
          Cut your takes into a finished piece, then export it for every screen. New productions start on the web.
        </Typography>
      </Stack>
      {list.items.length === 0 ? (
        <CenteredState
          title="No productions yet"
          body="Start one in Studio on the web, then add clips from your Library. It shows up here to edit and export."
          testId="studio-productions-empty"
        />
      ) : (
        <Box sx={{ ...studioPanelSx, overflow: 'hidden' }}>
          {list.items.map(item => (
            <ProductionRow key={item.id} item={item} onOpen={() => onOpen(item.id)} />
          ))}
        </Box>
      )}
      {list.error && list.items.length > 0 && (
        <Typography level="body-sm" sx={{ color: studioColor('danger') }}>
          {list.error.message}
        </Typography>
      )}
      {list.hasMore && (
        <Button
          variant="outlined"
          color="neutral"
          loading={list.loading}
          onClick={() => void list.loadMore()}
          sx={{ alignSelf: 'center' }}
          data-testid="studio-productions-more-btn"
        >
          Load more
        </Button>
      )}
    </Stack>
  );
}

function Section({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <Stack spacing={1.25} sx={{ ...studioPanelSx, p: 2 }} data-testid={testId}>
      <Typography sx={studioMicroLabelSx}>{label}</Typography>
      {children}
    </Stack>
  );
}

function TitleField({
  title,
  disabled,
  onRename,
}: {
  title: string;
  disabled: boolean;
  onRename: (title: string) => void;
}) {
  const [draft, setDraft] = useState(title);
  useEffect(() => setDraft(title), [title]);
  const commit = () => {
    const next = draft.trim();
    if (!next) return setDraft(title);
    if (next !== title) onRename(next);
  };
  return (
    <Input
      value={draft}
      disabled={disabled}
      onChange={event => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={event => {
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') setDraft(title);
      }}
      slotProps={{ input: { maxLength: 200, 'aria-label': 'Production title' } }}
      sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}
      data-testid="studio-production-title-input"
    />
  );
}

function ClipOrder({
  tracks,
  disabled,
  onMove,
}: {
  tracks: ProductionVideoTrack[];
  disabled: boolean;
  onMove: (track: ProductionVideoTrack, from: number, to: number) => void;
}) {
  if (tracks.every(track => track.clips.length === 0)) {
    return (
      <Typography
        level="body-sm"
        sx={{ color: studioColor('text-secondary') }}
        data-testid="studio-production-no-clips"
      >
        No video clips yet. Add clips to the timeline on the web, then come back to order and export them.
      </Typography>
    );
  }
  return (
    <Stack spacing={1.5}>
      {tracks.map((track, trackIndex) => (
        <Stack key={track.id} spacing={0.5} data-testid={`studio-production-track-${track.id}`}>
          {tracks.length > 1 && (
            <Typography level="body-xs" sx={{ color: studioColor('text-muted') }}>
              Video track {trackIndex + 1}
              {track.enabled ? '' : ' (hidden)'}
            </Typography>
          )}
          {track.clips.map((clip, index) => (
            <Stack
              key={clip.id}
              direction="row"
              alignItems="center"
              spacing={1}
              sx={{
                px: 1.25,
                py: 0.75,
                borderRadius: studioRadius('md'),
                border: `1px solid ${studioColor('hairline')}`,
                bgcolor: studioColor('raised'),
              }}
              data-testid={`studio-production-clip-${clip.id}`}
            >
              <Typography level="body-xs" sx={{ color: studioColor('text-muted'), width: 20, textAlign: 'right' }}>
                {index + 1}
              </Typography>
              <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0, color: studioColor('text-strong') }}>
                {clip.label}
              </Typography>
              <Typography level="body-xs" sx={{ color: studioColor('text-muted') }}>
                {formatSeconds(clip.durationMs)}
              </Typography>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Move ${clip.label} earlier`}
                disabled={disabled || index === 0}
                onClick={() => onMove(track, index, index - 1)}
                data-testid={`studio-production-clip-up-${clip.id}`}
              >
                <ArrowUpIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Move ${clip.label} later`}
                disabled={disabled || index === track.clips.length - 1}
                onClick={() => onMove(track, index, index + 1)}
                sx={{ '& svg': { transform: 'rotate(180deg)' } }}
                data-testid={`studio-production-clip-down-${clip.id}`}
              >
                <ArrowUpIcon />
              </IconButton>
            </Stack>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function StateChip({ state }: { state: GenerationJobState }) {
  const tone = STATE_TONE[state];
  return (
    <Box
      component="span"
      sx={{
        px: 1,
        py: '2px',
        fontSize: '11.5px',
        fontWeight: 600,
        borderRadius: studioRadius('sm'),
        border: `1px solid ${tone ? studioColor(`${tone}-border`) : studioColor('border')}`,
        bgcolor: tone ? studioColor(`${tone}-soft`) : studioColor('sunken'),
        color:
          tone === 'accent' ? studioColor('accent-on-soft') : tone ? studioColor(tone) : studioColor('text-secondary'),
      }}
      data-testid={`studio-production-render-state-${state}`}
    >
      {STATE_LABEL[state]}
    </Box>
  );
}

function RenderPlayer({ api, fileId }: { api: Pick<ProductionsApi, 'media'>; fileId: string }) {
  const media = useRenderMedia(api, fileId);
  if (media.status === 'ready') {
    return (
      <Box
        component="video"
        src={media.media.url}
        controls
        autoPlay
        sx={{ width: '100%', maxHeight: 420, borderRadius: studioRadius('md'), bgcolor: '#000' }}
        data-testid="studio-production-render-video"
      />
    );
  }
  if (media.status === 'error') {
    return (
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography level="body-sm" sx={{ color: studioColor('danger') }}>
          {media.message}
        </Typography>
        <Button size="sm" variant="plain" color="neutral" onClick={media.retry}>
          Retry
        </Button>
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={1} alignItems="center" data-testid="studio-production-render-video-loading">
      <CircularProgress size="sm" />
      <Typography level="body-sm" sx={{ color: studioColor('text-secondary') }}>
        Downloading the export...
      </Typography>
    </Stack>
  );
}

function RenderRow({
  job,
  api,
  playing,
  onPlay,
}: {
  job: ProductionRenderJob;
  api: Pick<ProductionsApi, 'media'>;
  playing: boolean;
  onPlay: () => void;
}) {
  return (
    <Stack spacing={0.75} sx={{ py: 1 }} data-testid={`studio-production-render-${job.id}`}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography level="body-sm" sx={{ color: studioColor('text-strong'), minWidth: 120 }}>
          {job.output.aspectRatio} ({job.output.width}x{job.output.height})
        </Typography>
        <StateChip state={job.state} />
        <Box sx={{ flex: 1 }} />
        {job.state === 'succeeded' && job.fileId && (
          <Button
            size="sm"
            variant={playing ? 'soft' : 'outlined'}
            color="neutral"
            onClick={onPlay}
            data-testid={`studio-production-render-play-${job.id}`}
          >
            {playing ? 'Hide' : 'Play'}
          </Button>
        )}
      </Stack>
      {isRenderInFlight(job) && (
        <LinearProgress
          determinate={job.progress !== null}
          value={job.progress !== null ? job.progress * 100 : undefined}
          sx={{ '--LinearProgress-progressColor': studioColor('accent') }}
          data-testid={`studio-production-render-progress-${job.id}`}
        />
      )}
      {job.errorMessage && (job.state === 'failed' || job.state === 'blocked') && (
        <Typography level="body-xs" sx={{ color: studioColor('danger') }}>
          {job.errorMessage}
        </Typography>
      )}
      {playing && job.fileId && <RenderPlayer api={api} fileId={job.fileId} />}
    </Stack>
  );
}

function ExportPanel({
  api,
  detail,
  disabled,
}: {
  api: Pick<ProductionsApi, 'renders' | 'render' | 'media'>;
  detail: ProductionDetail;
  disabled: boolean;
}) {
  const renders = useRenderJobs(api, detail.id);
  const [selected, setSelected] = useState<string[]>(() => detail.outputs.map(output => output.id));
  const [startError, setStartError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const hasClips = detail.videoTracks.some(track => track.clips.length > 0);

  const groups = new Map<string, ProductionRenderJob[]>();
  for (const job of renders.jobs) groups.set(job.groupId, [...(groups.get(job.groupId) ?? []), job]);

  const start = async () => {
    setStartError(null);
    const result = await renders.start(selected);
    if (!result.ok) setStartError(result.message);
  };

  return (
    <Section label="Export" testId="studio-production-export">
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5}>
        {detail.outputs.map(output => (
          <Checkbox
            key={output.id}
            size="sm"
            label={`${output.aspectRatio} (${output.width}x${output.height})`}
            checked={selected.includes(output.id)}
            onChange={event =>
              setSelected(previous =>
                event.target.checked ? [...previous, output.id] : previous.filter(id => id !== output.id)
              )
            }
            data-testid={`studio-production-output-${output.id}`}
          />
        ))}
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
        <Button
          size="sm"
          disabled={disabled || !hasClips || selected.length === 0}
          loading={renders.starting}
          onClick={() => void start()}
          sx={{ bgcolor: studioColor('accent'), '&:hover': { bgcolor: studioColor('accent-hover') } }}
          data-testid="studio-production-export-btn"
        >
          Export {selected.length} {selected.length === 1 ? 'size' : 'sizes'}
        </Button>
        <Typography level="body-xs" sx={{ color: studioColor('text-muted'), flex: 1, minWidth: 200 }}>
          Billed per second of output to your account&apos;s active organization, as on the web. Credits are refunded if
          an export fails.
        </Typography>
      </Stack>
      {startError && (
        <Typography level="body-sm" sx={{ color: studioColor('danger') }} data-testid="studio-production-export-error">
          {startError}
        </Typography>
      )}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ pt: 0.5 }}>
        <Typography sx={{ ...studioMicroLabelSx, flex: 1 }}>Recent exports</Typography>
        {renders.status === 'polling' && <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />}
        {(renders.status === 'idle' || renders.status === 'stalled') && (
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={renders.refresh}
            data-testid="studio-production-renders-refresh-btn"
          >
            Check again
          </Button>
        )}
      </Stack>
      {renders.status === 'stalled' && (
        <Typography
          level="body-xs"
          sx={{ color: studioColor('text-muted') }}
          data-testid="studio-production-renders-stalled"
        >
          Still rendering. Stopped checking for now; the export keeps going.
        </Typography>
      )}
      {renders.error && (
        <Typography level="body-sm" sx={{ color: studioColor('danger') }}>
          {renders.error.message}
        </Typography>
      )}
      {renders.status === 'loading' ? (
        <CircularProgress size="sm" />
      ) : renders.jobs.length === 0 ? (
        <Typography
          level="body-sm"
          sx={{ color: studioColor('text-secondary') }}
          data-testid="studio-production-renders-empty"
        >
          No exports yet.
        </Typography>
      ) : (
        [...groups.values()].map(jobs => (
          <Box key={jobs[0].groupId} sx={{ borderTop: `1px solid ${studioColor('hairline')}` }}>
            <Typography level="body-xs" sx={{ color: studioColor('text-muted'), pt: 1 }}>
              {formatUpdated(jobs[0].createdAt)}
            </Typography>
            {jobs.map(job => (
              <RenderRow
                key={job.id}
                job={job}
                api={api}
                playing={playing === job.id}
                onPlay={() => setPlaying(current => (current === job.id ? null : job.id))}
              />
            ))}
          </Box>
        ))
      )}
    </Section>
  );
}

function ProductionEditor({
  api,
  id,
  onBack,
  onSaved,
}: {
  api: ProductionsApi;
  id: string;
  onBack: () => void;
  onSaved: (summary: ProductionSummary) => void;
}) {
  const production = useProduction(api, id);
  const { detail } = production;

  const saved = (next: ProductionDetail | null) => {
    if (next) onSaved({ id: next.id, title: next.title, template: next.template, updatedAt: next.updatedAt });
  };

  const move = async (track: ProductionVideoTrack, from: number, to: number) => {
    const order = track.clips.map(clip => clip.id);
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    saved(await production.reorder(track.id, order));
  };

  const header = (
    <Stack direction="row" alignItems="center" spacing={1}>
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label="Back to Productions"
        onClick={onBack}
        data-testid="studio-production-back-btn"
      >
        <ArrowLeftIcon />
      </IconButton>
      {detail ? (
        <TitleField
          title={detail.title}
          disabled={production.saving}
          onRename={title => void production.rename(title).then(saved)}
        />
      ) : (
        <Typography level="title-lg" sx={{ color: studioColor('text-strong') }}>
          Production
        </Typography>
      )}
      {detail && (
        <Typography
          level="body-xs"
          sx={{ color: production.saveError ? studioColor('danger') : studioColor('text-muted'), flexShrink: 0 }}
          data-testid="studio-production-save-status"
        >
          {production.saving ? 'Saving...' : production.saveError ? 'Not saved' : 'Saved'}
        </Typography>
      )}
    </Stack>
  );

  if (production.error) {
    return (
      <Stack spacing={2} sx={{ maxWidth: 960, mx: 'auto' }}>
        {header}
        <ErrorState error={production.error} onRetry={production.reload} testIdPrefix="studio-production" />
      </Stack>
    );
  }
  if (!detail) {
    return (
      <Stack spacing={2} sx={{ maxWidth: 960, mx: 'auto' }}>
        {header}
        <Stack alignItems="center" sx={{ mt: 6 }}>
          <CircularProgress size="sm" />
        </Stack>
      </Stack>
    );
  }
  return (
    <Stack spacing={2} sx={{ maxWidth: 960, mx: 'auto' }} data-testid="studio-production-editor">
      {header}
      <Typography level="body-xs" sx={{ color: studioColor('text-muted'), pl: 5 }}>
        {templateLabel(detail.template)} - {formatSeconds(detail.durationMs)}
        {detail.otherClipCount > 0
          ? ` - ${detail.otherClipCount} voice, music and caption clips (edit on the web)`
          : ''}
      </Typography>
      {production.saveError && (
        <Typography level="body-sm" sx={{ color: studioColor('danger') }} data-testid="studio-production-save-error">
          {production.saveError}
        </Typography>
      )}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
          alignItems: 'start',
        }}
      >
        <Section label="Clip order" testId="studio-production-clips">
          <Typography level="body-xs" sx={{ color: studioColor('text-muted') }}>
            Moving a clip plays the track&apos;s clips back to back in the new order. Voice, music and captions stay
            where they are.
          </Typography>
          <ClipOrder
            tracks={detail.videoTracks}
            disabled={production.saving}
            onMove={(track, from, to) => void move(track, from, to)}
          />
        </Section>
        <ExportPanel api={api} detail={detail} disabled={production.saving} />
      </Box>
    </Stack>
  );
}

/**
 * The Studio place's Productions tab: the account's productions, then one opened to rename it,
 * reorder its clips and export it. Mirrors web Studio's list-then-editor flow at a smaller scope;
 * creating, the brief, the brand kit and the multi-lane timeline stay on the web for now.
 */
export function StudioProductions({ api = window.b4m.productions }: { api?: ProductionsApi }) {
  const auth = useAuthState();
  const accountKey = `${auth?.environment.url ?? ''}:${auth?.user?.id ?? ''}:${auth?.status ?? ''}`;
  const list = useProductionList(api, accountKey);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => setOpenId(null), [accountKey]);

  return (
    <Box sx={{ color: studioColor('text') }} data-testid="studio-productions">
      {openId ? (
        <ProductionEditor key={openId} api={api} id={openId} onBack={() => setOpenId(null)} onSaved={list.update} />
      ) : (
        <ProductionsList list={list} onOpen={setOpenId} />
      )}
    </Box>
  );
}

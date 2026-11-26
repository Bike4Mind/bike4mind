import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import type { StudioAsset, StudioJob, StudioMediaKind } from '@shared/studio';
import { studioAssetTitle } from '@shared/studioAssetTitle';
import { MediumGlyph } from './design/MediumGlyph';
import {
  studioColor,
  studioFocusSx,
  studioMicroLabelSx,
  studioPanelSx,
  studioRadius,
  studioTransitionSx,
} from './design/studioTokens';
import { mediaLabel } from './media';

/**
 * The takes grid: assets and in-flight jobs as tiles, after web Studio's StudioTakeTile and
 * StudioTakesStates (apps/client Studio/design). The `data-testid`s are the ones the list used.
 */
export function TakesGrid({ children }: { children: ReactNode }) {
  return (
    <Box
      component="ul"
      data-testid="studio-asset-list"
      sx={{
        p: 0,
        m: 0,
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 1.5,
      }}
    >
      {children}
    </Box>
  );
}

type ChipTone = 'neutral' | 'progress' | 'danger';

const CHIP_TONES: Record<ChipTone, { color: string; bg: string; border: string }> = {
  neutral: { color: studioColor('text-secondary'), bg: studioColor('scrim'), border: studioColor('border') },
  progress: { color: studioColor('warning'), bg: studioColor('warning-soft'), border: studioColor('warning-border') },
  danger: { color: studioColor('danger'), bg: studioColor('danger-soft'), border: studioColor('danger-border') },
};

function StatusChip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  const colors = CHIP_TONES[tone];
  return (
    <Box
      component="span"
      sx={{
        position: 'absolute',
        top: 8,
        left: 8,
        px: 1,
        py: '2px',
        fontSize: '10.5px',
        fontWeight: 600,
        lineHeight: 1.4,
        borderRadius: studioRadius('pill'),
        color: colors.color,
        bgcolor: colors.bg,
        border: `1px solid ${colors.border}`,
        backdropFilter: 'blur(6px)',
      }}
    >
      {children}
    </Box>
  );
}

const artSx = {
  position: 'relative',
  aspectRatio: '1 / 1',
  overflow: 'hidden',
  bgcolor: studioColor('raised'),
  display: 'grid',
  placeItems: 'center',
  color: studioColor('text-muted'),
} as const;

const tileSx = {
  ...studioPanelSx,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
} as const;

function TileMeta({ title, detail, detailTitle }: { title: string; detail: string; detailTitle?: string }) {
  return (
    <Box sx={{ px: 1.25, py: 1, minWidth: 0, textAlign: 'left' }}>
      <Typography level="body-sm" noWrap title={title} sx={{ color: studioColor('text'), fontWeight: 500 }}>
        {title}
      </Typography>
      <Typography level="body-xs" noWrap title={detailTitle} sx={{ color: studioColor('text-muted') }}>
        {detail}
      </Typography>
    </Box>
  );
}

function AssetArt({ asset }: { asset: StudioAsset }) {
  if (asset.kind === 'image' && asset.url)
    return (
      <Box
        component="img"
        src={asset.url}
        alt=""
        loading="lazy"
        sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  if (asset.kind === 'video' && asset.url)
    return (
      <Box
        component="video"
        src={asset.url}
        muted
        playsInline
        preload="metadata"
        aria-hidden="true"
        sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
      />
    );
  return (
    <Box
      sx={{
        width: 44,
        height: 44,
        display: 'grid',
        placeItems: 'center',
        borderRadius: studioRadius('md'),
        bgcolor: studioColor('surface'),
        border: `1px solid ${studioColor('hairline')}`,
      }}
    >
      <MediumGlyph kind={asset.kind} size={22} />
    </Box>
  );
}

export function AssetTake({ asset, onOpen }: { asset: StudioAsset; onOpen: () => void }) {
  const title = studioAssetTitle(asset);
  return (
    <Box component="li" sx={{ minWidth: 0 }}>
      <Box
        component="button"
        type="button"
        onClick={onOpen}
        data-testid={`studio-asset-${asset.id}-btn`}
        sx={{
          ...tileSx,
          ...studioTransitionSx,
          ...studioFocusSx,
          width: '100%',
          p: 0,
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          '&:hover': { borderColor: studioColor('border-strong'), bgcolor: studioColor('hover') },
        }}
      >
        <Box sx={artSx}>
          <AssetArt asset={asset} />
          <StatusChip tone="neutral">{mediaLabel(asset.kind)}</StatusChip>
        </Box>
        <TileMeta title={title} detail={new Date(asset.createdAt).toLocaleDateString()} />
      </Box>
    </Box>
  );
}

const JOB_STATUS: Record<StudioJob['state'], string> = {
  submitting: 'Starting...',
  queued: 'Queued',
  running: 'Creating...',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Status unavailable',
};

const ACTIVE_JOB_STATES: readonly StudioJob['state'][] = ['submitting', 'queued', 'running'];

// Web's skeleton sweep (StudioTakesStates.tsx): a 1.4s pass of the hover tone across the raised surface.
const shimmerSx = {
  backgroundImage: `linear-gradient(90deg, ${studioColor('raised')} 0%, ${studioColor('hover')} 50%, ${studioColor('raised')} 100%)`,
  backgroundSize: '200% 100%',
  animation: 'studio-take-shimmer 1.4s linear infinite',
  '@keyframes studio-take-shimmer': { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
} as const;

export function JobTake({
  job,
  onAction,
}: {
  job: StudioJob;
  /** Recheck or cancel; absent when the controller has no job actions. */
  onAction?: (action: 'recheck' | 'cancel') => void;
}) {
  const active = ACTIVE_JOB_STATES.includes(job.state);
  const status = job.error ?? JOB_STATUS[job.state];
  const tone: ChipTone = active ? 'progress' : job.state === 'failed' || job.error ? 'danger' : 'neutral';
  const canAct = onAction && !['completed', 'failed', 'cancelled'].includes(job.state);
  return (
    <Box component="li" data-testid={`studio-job-${job.id}`} sx={{ ...tileSx, position: 'relative' }}>
      <Box sx={{ ...artSx, ...(active && shimmerSx) }}>
        {!active && <MediumGlyph kind={job.kind} size={22} />}
        <StatusChip tone={tone}>
          {active ? JOB_STATUS[job.state] : job.state === 'failed' ? 'Failed' : mediaLabel(job.kind)}
        </StatusChip>
      </Box>
      <TileMeta title={mediaLabel(job.kind)} detail={status} detailTitle={job.error ?? undefined} />
      {canAct && (
        <Dropdown>
          <MenuButton
            size="sm"
            variant="plain"
            aria-label="Generation actions"
            sx={{
              position: 'absolute',
              top: 6,
              right: 6,
              minWidth: 26,
              minHeight: 26,
              px: 0.5,
              borderRadius: studioRadius('sm'),
              color: studioColor('text'),
              bgcolor: studioColor('scrim'),
              border: `1px solid ${studioColor('border-strong')}`,
              backdropFilter: 'blur(6px)',
            }}
          >
            {'\u22EF'}
          </MenuButton>
          <Menu placement="bottom-end">
            <MenuItem data-testid={`studio-job-${job.id}-recheck-btn`} onClick={() => onAction('recheck')}>
              Recheck status
            </MenuItem>
            {['video', 'music'].includes(job.kind) && job.providerJobId && (
              <MenuItem
                color="danger"
                data-testid={`studio-job-${job.id}-cancel-btn`}
                onClick={() => onAction('cancel')}
              >
                Cancel job
              </MenuItem>
            )}
          </Menu>
        </Dropdown>
      )}
    </Box>
  );
}

/** Web's framed empty state; the sentence keeps its `studio-empty` id. */
export function TakesEmpty({ kind = 'image' }: { kind?: StudioMediaKind }) {
  return (
    <Box
      sx={{
        border: `1px dashed ${studioColor('border')}`,
        borderRadius: studioRadius('lg'),
        px: 2.5,
        py: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1,
        textAlign: 'center',
      }}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          display: 'grid',
          placeItems: 'center',
          borderRadius: studioRadius('md'),
          bgcolor: studioColor('raised'),
          border: `1px solid ${studioColor('hairline')}`,
          color: studioColor('text-muted'),
        }}
      >
        <MediumGlyph kind={kind} size={20} />
      </Box>
      <Typography level="body-sm" data-testid="studio-empty" sx={{ color: studioColor('text-secondary') }}>
        Your creations will appear here.
      </Typography>
    </Box>
  );
}

export function TakesHeading({ count, title = 'Takes' }: { count: number; title?: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }} data-testid="studio-gallery-title">
      <Typography level="title-sm" sx={{ color: studioColor('text-strong'), fontWeight: 600 }}>
        {title}
      </Typography>
      {count > 0 && (
        <Typography component="span" sx={{ ...studioMicroLabelSx, letterSpacing: '0.04em' }}>
          {count}
        </Typography>
      )}
    </Box>
  );
}

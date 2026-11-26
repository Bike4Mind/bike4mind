import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { StudioMediaKind } from '@shared/studio';
import { thinScrollbarSx } from '../layout';
import type { StudioController } from '../studio/controller';
import { StudioScope } from '../studio/design/StudioScope';
import { studioColor, studioFocusSx, studioRadius, studioTransitionSx } from '../studio/design/studioTokens';
import { STUDIO_MEDIA } from '../studio/media';
import { StudioContent, tileUnavailableReason } from '../studio/StudioPane';
import type { StudioArea } from './places';

const AREAS: readonly { area: StudioArea; label: string }[] = [
  { area: 'create', label: 'Create' },
  { area: 'productions', label: 'Productions' },
  { area: 'library', label: 'Library' },
];

// Web switches its rail and header at viewport breakpoints; the place sits beside the app rail, so it asks its own width.
const STAGE = 'studio-stage';
const WIDE = `@container ${STAGE} (min-width: 760px)`;
const NARROW = `@container ${STAGE} (max-width: 599.95px)`;

/** Create | Productions | Library, drawn like web Studio's StudioSegmentedControl. */
function AreaSwitcher({ area, onChange }: { area: StudioArea; onChange: (area: StudioArea) => void }) {
  return (
    <Box
      role="tablist"
      aria-label="Studio areas"
      sx={{
        display: 'inline-flex',
        gap: '2px',
        p: '3px',
        borderRadius: studioRadius('md'),
        bgcolor: studioColor('sunken'),
        border: `1px solid ${studioColor('hairline')}`,
        [NARROW]: { display: 'flex', width: '100%' },
      }}
      data-testid="studio-area-nav"
    >
      {AREAS.map(({ area: value, label }) => (
        <Box
          key={value}
          component="button"
          type="button"
          role="tab"
          aria-selected={area === value}
          onClick={() => onChange(value)}
          sx={{
            ...studioTransitionSx,
            ...studioFocusSx,
            border: 0,
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '13px',
            fontWeight: 500,
            px: 1.75,
            py: '6px',
            borderRadius: studioRadius('sm'),
            color: area === value ? studioColor('text-strong') : studioColor('text-secondary'),
            bgcolor: area === value ? studioColor('selected') : 'transparent',
            boxShadow: area === value ? `0 0 0 1px ${studioColor('border')}` : 'none',
            '&:hover': { color: studioColor('text-strong') },
            [NARROW]: { flex: 1 },
          }}
          data-testid={`studio-area-${value}`}
        >
          {label}
        </Box>
      ))}
    </Box>
  );
}

/** Create's medium picker, web's StudioMediumRail: a column of icon tiles beside the form, a scrolling row above it when narrow. */
function MediumRail({
  kind,
  controller,
  unavailableReason,
  onSelect,
}: {
  kind: StudioMediaKind;
  controller?: StudioController;
  unavailableReason?: string;
  onSelect: (kind: StudioMediaKind) => void;
}) {
  return (
    <Box
      component="nav"
      aria-label="Medium"
      data-testid="studio-medium-rail"
      sx={{
        display: 'flex',
        gap: '6px',
        px: 2,
        py: '10px',
        overflowX: 'auto',
        ...thinScrollbarSx,
        flexShrink: 0,
        borderBottom: `1px solid ${studioColor('hairline')}`,
        [WIDE]: {
          flex: '0 0 88px',
          flexDirection: 'column',
          px: '10px',
          py: 2.5,
          overflowX: 'visible',
          borderBottom: 0,
          borderRight: `1px solid ${studioColor('hairline')}`,
        },
      }}
    >
      {STUDIO_MEDIA.map(medium => {
        const reason = tileUnavailableReason(controller, medium.kind, unavailableReason);
        const current = medium.kind === kind;
        return (
          <Box
            key={medium.kind}
            component="button"
            type="button"
            aria-current={current ? 'page' : undefined}
            // A busy Studio still lets the user look at another medium; only an unsupported one is closed.
            disabled={!!reason && reason !== 'Studio is busy.'}
            title={reason ?? undefined}
            onClick={() => onSelect(medium.kind)}
            data-testid={`studio-rail-${medium.kind}`}
            sx={{
              ...studioTransitionSx,
              ...studioFocusSx,
              flex: '0 0 auto',
              minWidth: 64,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '6px',
              px: '4px',
              py: 1,
              borderRadius: studioRadius('md'),
              border: '1px solid transparent',
              bgcolor: 'transparent',
              color: studioColor('text-secondary'),
              font: 'inherit',
              fontSize: '12px',
              fontWeight: 500,
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              '& .studio-rail-glyph': {
                ...studioTransitionSx,
                display: 'grid',
                placeItems: 'center',
                width: 36,
                height: 36,
                borderRadius: studioRadius('md'),
                bgcolor: studioColor('raised'),
              },
              '&:hover:not(:disabled)': {
                color: studioColor('text'),
                '& .studio-rail-glyph': { bgcolor: studioColor('hover') },
              },
              '&[aria-current="page"]': {
                borderColor: studioColor('accent-border'),
                bgcolor: studioColor('accent-soft'),
                color: studioColor('text-strong'),
                '& .studio-rail-glyph': { bgcolor: studioColor('accent'), color: studioColor('accent-contrast') },
              },
              '&:disabled': { cursor: 'default', opacity: 0.5 },
            }}
          >
            <span className="studio-rail-glyph" aria-hidden="true">
              {medium.icon}
            </span>
            {medium.label}
          </Box>
        );
      })}
    </Box>
  );
}

function EmptyState({ title, body, testId }: { title: string; body: string; testId: string }) {
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
    </Stack>
  );
}

/**
 * The Studio place, laid out like web Studio's StudioV2Frame: a header with the Studio title and the
 * Create | Productions | Library switcher, then the area. Create is web's StudioCreateV2Page: the medium
 * rail beside the medium's form, with that medium's takes under it, bound to the place's own Studio session
 * (the Studio workspace, its jobs and its assets all belong to a session).
 *
 * `productions` and `library` are the other areas' bodies, owned by their own modules; without one the
 * area says it is not on desktop yet.
 */
export function StudioMain({
  area,
  onAreaChange,
  kind,
  onKindChange,
  controller,
  ready,
  unavailableReason,
  productions,
  library,
}: {
  area: StudioArea;
  onAreaChange: (area: StudioArea) => void;
  kind: StudioMediaKind | null;
  onKindChange: (kind: StudioMediaKind | null) => void;
  controller?: StudioController;
  /** The Studio session Create saves into is bound; until then `unavailableReason` says why not. */
  ready: boolean;
  unavailableReason?: string;
  productions?: ReactNode;
  library?: ReactNode;
}) {
  // Create always shows a medium, as web's /studio/<medium> does; Image leads.
  const medium = kind ?? STUDIO_MEDIA[0].kind;
  const scrollSx = { flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', ...thinScrollbarSx } as const;
  const mainSx = { p: 3, [NARROW]: { p: 2 } } as const;

  let body: ReactNode;
  if (area === 'productions') {
    body = (
      <Box sx={{ ...scrollSx, ...mainSx }}>
        {productions ?? (
          <EmptyState
            title="Productions are coming to desktop"
            body="Cut your takes into a finished piece on a timeline. Until then, Productions is on the web."
            testId="studio-productions-empty"
          />
        )}
      </Box>
    );
  } else if (area === 'library') {
    body = (
      <Box sx={{ ...scrollSx, display: 'flex', flexDirection: 'column' }} data-testid="studio-library">
        {library ?? (
          <EmptyState
            title="Your Library is a place of its own"
            body="Open Library from the rail to browse everything you have made."
            testId="studio-library-empty"
          />
        )}
      </Box>
    );
  } else {
    body = (
      <Box
        sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', [WIDE]: { flexDirection: 'row' } }}
        data-testid="studio-create-body"
      >
        <MediumRail
          kind={medium}
          controller={controller}
          unavailableReason={unavailableReason}
          onSelect={onKindChange}
        />
        <Box sx={{ ...scrollSx, ...mainSx, containerType: 'inline-size', containerName: 'studio-main' }}>
          {!ready ? (
            <EmptyState title="Nothing to create in yet" body={unavailableReason ?? ''} testId="studio-create-empty" />
          ) : (
            <Box sx={{ maxWidth: 1600, mx: 'auto' }} data-testid="studio-create">
              <StudioContent
                key={`${controller?.sessionId ?? ''}:${controller?.workspaceId ?? ''}`}
                controller={controller}
                kind={medium}
                setKind={onKindChange}
                unavailableReason={unavailableReason}
                layout="place"
              />
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <StudioScope
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        containerType: 'inline-size',
        containerName: STAGE,
      }}
      testId="studio-place"
    >
      <Box
        component="header"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '12px 24px',
          px: 3,
          py: '14px',
          borderBottom: `1px solid ${studioColor('hairline')}`,
          [NARROW]: { px: 2, py: 1.5 },
        }}
        data-testid="studio-header"
      >
        <Typography
          component="h1"
          data-testid="studio-title"
          sx={{
            m: 0,
            fontSize: '18px',
            fontWeight: 700,
            lineHeight: 1.2,
            letterSpacing: '-0.01em',
            color: studioColor('text-strong'),
          }}
        >
          Studio
        </Typography>
        <Box sx={{ minWidth: 0, [NARROW]: { flexBasis: '100%' } }}>
          <AreaSwitcher area={area} onChange={onAreaChange} />
        </Box>
      </Box>
      {body}
    </StudioScope>
  );
}

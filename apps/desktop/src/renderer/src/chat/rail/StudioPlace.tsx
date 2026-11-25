import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { StudioMediaKind } from '@shared/studio';
import { ArrowLeftIcon, PanelLeftIcon } from '../icons';
import { thinScrollbarSx } from '../layout';
import { NavItem } from '../SessionList';
import type { StudioController } from '../studio/controller';
import { StudioScope } from '../studio/design/StudioScope';
import { studioColor, studioFocusSx, studioRadius, studioTransitionSx } from '../studio/design/studioTokens';
import { mediaLabel, STUDIO_MEDIA } from '../studio/media';
import { StudioContent, tileUnavailableReason } from '../studio/StudioPane';
import type { StudioArea } from './places';

const AREAS: readonly { area: StudioArea; label: string }[] = [
  { area: 'create', label: 'Create' },
  { area: 'productions', label: 'Productions' },
];

/**
 * The Studio place's sidebar: the media under a Create label, then Productions. Picking a medium
 * opens its form in the main pane, the same form the per-conversation Studio pane uses.
 */
export function StudioSidebar({
  width,
  area,
  kind,
  controller,
  unavailableReason,
  onSelectKind,
  onSelectArea,
  onToggleCollapsed,
}: {
  width: number;
  area: StudioArea;
  kind: StudioMediaKind | null;
  controller?: StudioController;
  unavailableReason?: string;
  onSelectKind: (kind: StudioMediaKind) => void;
  onSelectArea: (area: StudioArea) => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <Stack
      sx={{
        width,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
      data-testid="studio-sidebar"
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1, pl: 0.5 }} data-testid="sidebar-place-title">
          Studio
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Hide sidebar"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle-btn"
        >
          <PanelLeftIcon />
        </IconButton>
      </Stack>
      <Stack spacing={0.25} sx={{ px: 1, pb: 1, overflowY: 'auto', ...thinScrollbarSx }}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pt: 0.5, pb: 0.25 }}>
          Create
        </Typography>
        {STUDIO_MEDIA.map(tile => {
          const active = area === 'create' && kind === tile.kind;
          const reason = tileUnavailableReason(controller, tile.kind, unavailableReason);
          return (
            <Box
              key={tile.kind}
              title={reason ?? undefined}
              sx={{
                borderRadius: 'sm',
                bgcolor: active ? 'neutral.softBg' : undefined,
                opacity: reason ? 0.55 : 1,
                pointerEvents: reason ? 'none' : undefined,
              }}
              aria-disabled={reason ? true : undefined}
            >
              <NavItem
                icon={tile.icon}
                label={tile.label}
                onClick={() => onSelectKind(tile.kind)}
                testId={`studio-sidebar-${tile.kind}-btn`}
              />
            </Box>
          );
        })}
        <Box sx={{ pt: 1 }}>
          <Box sx={{ borderRadius: 'sm', bgcolor: area === 'productions' ? 'neutral.softBg' : undefined }}>
            <NavItem
              icon={null}
              label="Productions"
              onClick={() => onSelectArea('productions')}
              testId="studio-sidebar-productions-btn"
            />
          </Box>
        </Box>
      </Stack>
    </Stack>
  );
}

/** Create | Productions, drawn like the segmented control web Studio heads its areas with. */
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
            fontSize: '12.5px',
            fontWeight: 500,
            px: 1.5,
            py: '5px',
            borderRadius: studioRadius('sm'),
            color: area === value ? studioColor('text-strong') : studioColor('text-secondary'),
            bgcolor: area === value ? studioColor('selected') : 'transparent',
            boxShadow: area === value ? `0 0 0 1px ${studioColor('border')}` : 'none',
            '&:hover': { color: studioColor('text-strong') },
          }}
          data-testid={`studio-area-${value}`}
        >
          {label}
        </Box>
      ))}
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
 * The Studio place's main pane: a header with the area switcher, then Create or Productions.
 *
 * Create hosts the per-conversation Studio full width, bound to the place's own Studio session:
 * the Studio workspace, its jobs and its assets all belong to a session. Productions has no
 * desktop backend yet, so it says so.
 */
export function StudioMain({
  area,
  onAreaChange,
  kind,
  onKindChange,
  controller,
  ready,
  unavailableReason,
}: {
  area: StudioArea;
  onAreaChange: (area: StudioArea) => void;
  kind: StudioMediaKind | null;
  onKindChange: (kind: StudioMediaKind | null) => void;
  controller?: StudioController;
  /** The Studio session Create saves into is bound; until then `unavailableReason` says why not. */
  ready: boolean;
  unavailableReason?: string;
}) {
  return (
    <StudioScope
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      testId="studio-place"
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{ px: 2, py: 1.25, borderBottom: `1px solid ${studioColor('hairline')}` }}
        data-testid="studio-header"
      >
        {/* The sidebar already names the place, so the header carries only the switcher. */}
        <Box sx={{ flex: 1 }} />
        <AreaSwitcher area={area} onChange={onAreaChange} />
        <Box sx={{ flex: 1 }} />
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 3, py: 2.5, ...thinScrollbarSx }}>
        {area === 'productions' ? (
          <EmptyState
            title="Productions are coming to desktop"
            body="Cut your takes into a finished piece on a timeline. Until then, Productions is on the web."
            testId="studio-productions-empty"
          />
        ) : !ready ? (
          <EmptyState title="Nothing to create in yet" body={unavailableReason ?? ''} testId="studio-create-empty" />
        ) : (
          <Stack spacing={2} sx={{ maxWidth: 960, mx: 'auto' }} data-testid="studio-create">
            <Stack direction="row" alignItems="center" spacing={1}>
              {kind && (
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label="Back to Studio"
                  disabled={controller?.busy}
                  onClick={() => onKindChange(null)}
                  data-testid="studio-creation-back-btn"
                >
                  <ArrowLeftIcon />
                </IconButton>
              )}
              <Typography level="title-lg" sx={{ color: studioColor('text-strong'), fontWeight: 700 }}>
                {kind ? `Create ${mediaLabel(kind)}` : 'What are we making?'}
              </Typography>
            </Stack>
            <StudioContent
              key={`${controller?.sessionId ?? ''}:${controller?.workspaceId ?? ''}`}
              controller={controller}
              kind={kind}
              setKind={onKindChange}
              unavailableReason={unavailableReason}
            />
          </Stack>
        )}
      </Box>
    </StudioScope>
  );
}

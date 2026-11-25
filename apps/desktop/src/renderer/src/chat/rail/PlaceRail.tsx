import type { ReactNode } from 'react';
import Badge from '@mui/joy/Badge';
import IconButton from '@mui/joy/IconButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { stateJoyColor } from '../orchestrator/statePalette';
import { RailAgentsIcon, RailChatIcon, RailCodeIcon, RailLibraryIcon, RailStudioIcon } from '../icons';
import { hiddenScrollbarSx } from '../layout';
import { PLACES, placeHasSidebar, type Place } from './places';
import { placeShortcutLabel, sidebarShortcutLabel } from './shortcuts';

export const RAIL_WIDTH = 48;

/**
 * What the shell hands the rail's account slot: the turn dot, and the two screens the shell owns.
 * The route-backed rows (Settings, Profile, Billing) the slot navigates to itself.
 */
export interface RailAccountContext {
  /** The dot that says whether a reply is running; see TurnDot. */
  status: ReactNode;
  /** Ticks when a turn settles, for anything in the slot that reads the balance. */
  spentAt?: number;
  /** What the Customize screen would flag, if anything. */
  customizeAttention?: string;
  onOpenCustomize: () => void;
  onOpenModels: () => void;
}

const ICONS: Record<Place, () => ReactNode> = {
  chat: RailChatIcon,
  code: RailCodeIcon,
  studio: RailStudioIcon,
  agents: RailAgentsIcon,
  library: RailLibraryIcon,
};

/** A tooltip's label with its shortcut beside it, dimmer, so the label is read first. */
export function RailTooltipTitle({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <Stack direction="row" spacing={1} alignItems="baseline">
      <span>{label}</span>
      {shortcut && (
        <Typography level="body-xs" textColor="text.tertiary" component="span">
          {shortcut}
        </Typography>
      )}
    </Stack>
  );
}

/**
 * The rail's 32px button: muted until active, then full contrast on a soft pill. No accent
 * colour, so the only colour the rail ever shows is a badge that means something.
 */
export const railButtonSx = (active: boolean) => ({
  '--IconButton-size': '32px',
  borderRadius: 'md',
  color: active ? 'text.primary' : 'text.tertiary',
  bgcolor: active ? 'neutral.softBg' : 'transparent',
  '&:hover': { bgcolor: active ? 'neutral.softHoverBg' : 'neutral.plainHoverBg', color: 'text.primary' },
});

/**
 * The far-left column: the places, then the account at the foot. It never hides; collapsing the
 * sidebar leaves it as the only map of the app. The shell decides what a click does to the
 * sidebar; the active icon's tooltip says so, since that click shows or hides it.
 */
export function PlaceRail({
  place,
  sidebarCollapsed = false,
  onSelect,
  needsYou = 0,
  account,
}: {
  place: Place;
  sidebarCollapsed?: boolean;
  onSelect: (place: Place) => void;
  /** Sessions waiting on the user, badged on Agents: the dock badge's count (needsYouBadgeCount). */
  needsYou?: number;
  /** The avatar slot at the foot of the rail. */
  account?: ReactNode;
}) {
  return (
    <Stack
      component="nav"
      aria-label="Places"
      sx={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        height: '100%',
        alignItems: 'center',
        gap: 0.5,
        pt: 1.5,
        pb: 1.25,
        overflow: 'hidden',
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
      }}
      data-testid="place-rail"
    >
      {/* The places scroll when the window is too short for them, so the account cluster below
          (credits orb and avatar) is never pushed over them and never leaves the rail. */}
      <Stack
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          alignItems: 'center',
          gap: 0.5,
          py: 0.25,
          overflowY: 'auto',
          ...hiddenScrollbarSx,
        }}
        data-testid="rail-places"
      >
        {PLACES.map(({ place: value, label, digit }) => {
          const Icon = ICONS[value];
          const active = place === value;
          const badge = value === 'agents' ? needsYou : 0;
          return (
            <Tooltip
              key={value}
              title={
                active && placeHasSidebar(value) ? (
                  <RailTooltipTitle
                    label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
                    shortcut={sidebarShortcutLabel()}
                  />
                ) : (
                  <RailTooltipTitle label={label} shortcut={placeShortcutLabel(digit)} />
                )
              }
              placement="right"
              size="sm"
              variant="outlined"
              enterDelay={400}
            >
              <IconButton
                variant="plain"
                aria-label={badge > 0 ? `${label}, ${badge} ${badge === 1 ? 'needs' : 'need'} you` : label}
                aria-current={active ? 'page' : undefined}
                onClick={() => onSelect(value)}
                sx={railButtonSx(active)}
                data-testid={`place-rail-${value}-btn`}
              >
                {badge > 0 ? (
                  <Badge
                    badgeContent={badge}
                    max={99}
                    size="sm"
                    color={stateJoyColor('needs-you')}
                    badgeInset="-2px -4px auto auto"
                    slotProps={{ badge: { 'aria-hidden': true, 'data-testid': `place-rail-${value}-badge` } }}
                    sx={{ '--Badge-minHeight': '15px', '--Badge-paddingX': '3px' }}
                  >
                    <Icon />
                  </Badge>
                ) : (
                  <Icon />
                )}
              </IconButton>
            </Tooltip>
          );
        })}
      </Stack>
      <Stack sx={{ alignItems: 'center', gap: 0.5, flexShrink: 0 }} data-testid="rail-foot">
        {account}
      </Stack>
    </Stack>
  );
}

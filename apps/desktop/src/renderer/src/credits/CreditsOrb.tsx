import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { RailTooltipTitle } from '../chat/rail/PlaceRail';
import { formatCredits } from './CreditsGlance';
import { creditsOrbLabel, creditsOrbState, type CreditsOrbTone } from './creditsOrbState';
import type { CreditsGlance } from './useCreditsGlance';

const ORB_SIZE = 28;
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const TINT: Record<CreditsOrbTone, string> = {
  ok: 'var(--joy-palette-neutral-500)',
  unknown: 'var(--joy-palette-neutral-500)',
  low: 'var(--joy-palette-warning-500)',
  critical: 'var(--joy-palette-danger-500)',
};

/**
 * A glass orb whose fill is the remaining balance. Quiet while ok (a hairline ring and a faint
 * fill, no colour); low and critical tint the fill and the ring, so a near-empty orb still shows it. Pure CSS, and nothing in it moves except a
 * level change easing, which reduced motion turns off.
 */
export function CreditsOrbFace({ tone, level }: { tone: CreditsOrbTone; level: number }) {
  const attention = tone === 'low' || tone === 'critical';
  return (
    <Box
      component="span"
      aria-hidden
      data-testid="rail-credits-orb-face"
      data-tone={tone}
      sx={{
        position: 'relative',
        display: 'block',
        width: ORB_SIZE,
        height: ORB_SIZE,
        borderRadius: '50%',
        overflow: 'hidden',
        boxShadow: attention
          ? `inset 0 0 0 1.5px color-mix(in srgb, ${TINT[tone]} 85%, transparent)`
          : 'inset 0 0 0 1px var(--joy-palette-divider)',
        '&::before': {
          content: '""',
          position: 'absolute',
          left: '-30%',
          right: '-30%',
          bottom: 0,
          height: `${Math.round(Math.min(1, Math.max(0, level)) * 100)}%`,
          background: `color-mix(in srgb, ${TINT[tone]} ${attention ? 72 : 24}%, transparent)`,
          borderRadius: '42% 46% 0 0 / 14% 12% 0 0',
          transition: 'height 0.9s cubic-bezier(.2,.8,.2,1)',
          [REDUCED_MOTION]: { transition: 'none' },
        },
      }}
    />
  );
}

/**
 * The credits orb in its own slot above the avatar, and the small popover it opens: balance,
 * Top up, and who is paying. It only displays what the glance already read; opening it asks for
 * a refresh through `onOpenChange`, and the read gates decide whether that reads anything.
 */
export function CreditsOrb({
  glance,
  onOpenChange,
  onTopUp,
}: {
  glance: CreditsGlance;
  onOpenChange: (open: boolean) => void;
  onTopUp: () => void;
}) {
  const state = creditsOrbState(glance);
  const label = creditsOrbLabel(state);
  return (
    <Dropdown onOpenChange={(_event, open) => onOpenChange(open)}>
      <Tooltip
        title={<RailTooltipTitle label="Credits" />}
        placement="right"
        size="sm"
        variant="outlined"
        enterDelay={400}
      >
        <MenuButton
          variant="plain"
          aria-label={label}
          data-testid="rail-credits-orb"
          data-tone={state.tone}
          sx={{
            width: 32,
            height: 32,
            minHeight: 0,
            p: 0,
            flexShrink: 0,
            borderRadius: '50%',
            '&:hover': { bgcolor: 'neutral.plainHoverBg' },
          }}
        >
          <CreditsOrbFace tone={state.tone} level={state.level} />
        </MenuButton>
      </Tooltip>
      <Menu size="sm" placement="right-end" sx={{ minWidth: 200 }} data-testid="rail-credits-popover">
        <Stack spacing={0.25} sx={{ px: 1.5, pt: 1, pb: 1 }}>
          <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid="rail-credits-payer">
            {`Paying: ${glance.organization ? glance.organization.name : 'Personal'}`}
          </Typography>
          <Typography level="title-md" sx={{ fontVariantNumeric: 'tabular-nums' }} data-testid="rail-credits-balance">
            {state.balance === null ? 'Balance unavailable' : `${formatCredits(state.balance)} credits`}
          </Typography>
        </Stack>
        <Divider />
        <MenuItem onClick={onTopUp} data-testid="rail-credits-top-up-btn">
          Top up
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}

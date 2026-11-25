import Box from '@mui/joy/Box';
import Divider from '@mui/joy/Divider';
import Dropdown from '@mui/joy/Dropdown';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { keyframes } from '@mui/system';
import { RailTooltipTitle } from '../chat/rail/PlaceRail';
import { formatCredits } from './CreditsGlance';
import { creditsOrbLabel, creditsOrbState, type CreditsOrbTone } from './creditsOrbState';
import type { CreditsGlance } from './useCreditsGlance';

const ORB_SIZE = 28;
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const RING: Record<CreditsOrbTone, string> = {
  ok: 'color-mix(in srgb, var(--joy-palette-text-tertiary) 55%, transparent)',
  unknown: 'color-mix(in srgb, var(--joy-palette-text-tertiary) 55%, transparent)',
  low: 'var(--joy-palette-warning-400)',
  critical: 'var(--joy-palette-danger-500)',
};

const TEXT: Record<CreditsOrbTone, string> = {
  ok: 'var(--joy-palette-text-secondary)',
  unknown: 'var(--joy-palette-text-tertiary)',
  low: 'var(--joy-palette-warning-plainColor)',
  critical: 'var(--joy-palette-danger-plainColor)',
};

const halo = (tone: CreditsOrbTone, percent: number) =>
  `0 0 0 3px color-mix(in srgb, ${RING[tone]} ${percent}%, transparent)`;

const pulse = (tone: CreditsOrbTone) => keyframes`
  0%, 100% { box-shadow: inset 0 0 0 1.5px ${RING[tone]}, ${halo(tone, 22)}; }
  50% { box-shadow: inset 0 0 0 1.5px ${RING[tone]}, ${halo(tone, 6)}; }
`;
const PULSE: Partial<Record<CreditsOrbTone, ReturnType<typeof keyframes>>> = {
  low: pulse('low'),
  critical: pulse('critical'),
};

/**
 * The orb face: the balance as text inside a status ring. Neutral while the runway is long or
 * unknown; amber when low and red when critical, with a slow halo pulse that reduced motion
 * holds still. No fill: a balance has no maximum to fill toward.
 */
export function CreditsOrbFace({ tone, compact }: { tone: CreditsOrbTone; compact: string | null }) {
  const attention = tone === 'low' || tone === 'critical';
  const text = compact ?? '-';
  return (
    <Box
      component="span"
      aria-hidden
      data-testid="rail-credits-orb-face"
      data-tone={tone}
      sx={{
        display: 'grid',
        placeItems: 'center',
        width: ORB_SIZE,
        height: ORB_SIZE,
        borderRadius: '50%',
        color: TEXT[tone],
        // Four characters ("300k", "123M") need a size down to stay inside the ring.
        fontSize: text.length >= 4 ? '8px' : '9.5px',
        fontWeight: 650,
        letterSpacing: text.length >= 4 ? '-0.04em' : '-0.02em',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 0 0 1.5px ${RING[tone]}${attention ? `, ${halo(tone, 22)}` : ''}`,
        ...(attention && {
          animation: `${PULSE[tone]} 2.4s ease-in-out infinite`,
          [REDUCED_MOTION]: { animation: 'none' },
        }),
      }}
    >
      {text}
    </Box>
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
          <CreditsOrbFace tone={state.tone} compact={state.compact} />
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
          {state.runway === null ? null : (
            <Typography
              level="body-xs"
              data-testid="rail-credits-runway"
              textColor={
                state.tone === 'critical'
                  ? 'danger.plainColor'
                  : state.tone === 'low'
                    ? 'warning.plainColor'
                    : 'text.tertiary'
              }
            >
              {state.runway}
            </Typography>
          )}
        </Stack>
        {/* /billing tops up the personal account, so an organization pool offers none, as in the menu. */}
        {glance.organization ? null : <Divider />}
        {glance.organization ? null : (
          <MenuItem onClick={onTopUp} data-testid="rail-credits-top-up-btn">
            Top up
          </MenuItem>
        )}
      </Menu>
    </Dropdown>
  );
}

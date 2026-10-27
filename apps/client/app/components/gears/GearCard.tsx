import { Box, Card, Divider, Stack, Typography } from '@mui/joy';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { gray } from '@client/app/utils/themes/colors';
import { GearIcon } from './gearIcons';
import { ClaimButton, PendingRewardNote, RewardChip, rewardState } from './gearReward';

interface GearCardProps {
  gear: GearStatus;
  /** Bottom line of the card, e.g. the gear's CTA or "Learn more". */
  ctaLabel: string;
  onActivate: () => void;
  /** Without it the card never offers a claim (the discovery modal's cards are never claimable). */
  onClaim?: () => void;
  cardRef?: (el: HTMLDivElement | null) => void;
}

/** A Gears card, shared by the Gears page and the discovery modal. */
export const GearCard = ({ gear, ctaLabel, onActivate, onClaim, cardRef }: GearCardProps) => {
  const reward = rewardState(gear);
  const claimButton = onClaim && reward === 'claimable' && <ClaimButton gear={gear} onClaim={onClaim} />;
  return (
    // Every card looks the same whether or not its gear is earned: the page is
    // a place to read about features, and a checkmark grid turns it into a
    // score. The unlock still happens and still pays - it just is not what
    // this surface is for.
    // The whole card is the control: a solid Button per card
    // painted a grid of twenty-odd primary rectangles, which reads as twenty
    // equally urgent calls to action rather than a list to browse.
    <Card
      ref={cardRef}
      variant="outlined"
      data-testid={`gear-card-${gear.key}`}
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate();
        }
      }}
      sx={theme => ({
        display: 'flex',
        flexDirection: 'column',
        // Joy paints both a Card and PageFrame's Sheet with background.surface,
        // so without this the card would sit on its own colour in light mode and
        // read as a 1px outline on a flat sheet. White is a step past the theme's
        // body grey, to lift the card off the frame rather than just clear it.
        backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.body : gray[0],
        // The softest step of the border scale: `divider`
        // is the app's full-strength rule and reads as drawn lines across a
        // grid of thirty cards.
        borderColor: theme.palette.border.soft,
        // Spacing is per-child rather than a single column gap: the steps down
        // the card differ, so each margin is the gap above that element.
        gap: 0,
        cursor: 'pointer',
        transition:
          'background-color 0.18s ease-out, border-color 0.18s ease-out, transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)',
        '&:hover': {
          backgroundColor: theme.palette.loginRegister.termsAndPrivacy.hoverBg,
          borderColor: theme.palette.border.light,
          transform: 'translateY(-2px)',
        },
        '@media (prefers-reduced-motion: reduce)': {
          transition: 'background-color 0.18s ease-out, border-color 0.18s ease-out',
          '&:hover': { transform: 'none' },
        },
        '&:focus-visible': {
          outline: `2px solid ${theme.palette.primary[500]}`,
          outlineOffset: '2px',
        },
      })}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" gap={1}>
        <Stack direction="row" alignItems="center" gap={1}>
          <GearIcon gearKey={gear.key} />
          <Typography level="title-md">{gear.title}</Typography>
        </Stack>
        <RewardChip gear={gear} reward={reward} onClaim={onClaim} />
      </Stack>
      <Typography level="body-sm" sx={{ opacity: 0.85, mt: '16px' }}>
        {gear.intro}
      </Typography>
      {/* The deferred payout gets a full line rather than chip text: it is the
        one state a glance at a colour cannot explain, and there is room here.
        Copy is reason-specific: unverified and too-new accounts see a different
        message from the published rewardCheck case. */}
      {reward === 'pending' && <PendingRewardNote gear={gear} />}
      {/* Pinned to the bottom so the CTAs line up across a row of uneven cards. */}
      <Typography
        level="body-sm"
        data-testid={`gear-cta-${gear.key}`}
        sx={{ mt: 'auto', pt: '20px', color: 'text.primary' }}
      >
        {ctaLabel}
        {/* An HTML entity rather than the arrow character, so this file stays
        ASCII: Prettier rewrites a unicode escape back into the character. */}
        <Box component="span" sx={{ ml: '6px' }}>
          &rarr;
        </Box>
      </Typography>
      {/* A footer of its own under the CTA, split off by a divider, rather than a
          line between the copy and the CTA, where it was squeezed. The CTAs in a
          row stop lining up while a card has one - accepted, the state is brief
          and the misalignment points at the card that pays. */}
      {claimButton && (
        <>
          <Divider inset="context" sx={{ mt: '16px' }} />
          {claimButton}
        </>
      )}
    </Card>
  );
};

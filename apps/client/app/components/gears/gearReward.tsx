import { Chip, chipClasses, Tooltip, Typography } from '@mui/joy';
import CheckIcon from '@mui/icons-material/Check';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { neutralFrame, rewardGreen } from '@client/app/components/common/gearRewardStyles';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { grayAlpha } from '@client/app/utils/themes/colors';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { GEAR_TRUST_MIN_AGE_DAYS } from '@client/lib/gears/keys';

/** The reward as prose, for the tooltips: the chip shows the bare number. */
export const creditText = (gear: GearStatus) =>
  `${gear.credits.toLocaleString()} credit${gear.credits === 1 ? '' : 's'}`;

export type RewardState = 'locked' | 'claimable' | 'pending' | 'claimed' | 'none';

export const rewardState = (gear: GearStatus): RewardState => {
  // Checked before the unlock: a paid gear whose data was deleted is locked
  // again, but offering its reward a second time would be a promise the claim
  // endpoint refuses.
  if (gear.claimed) return 'claimed';
  // Set to 0 in Manage Gears: nothing to earn, so no marker. The fallback below would
  // otherwise show the grey check for a payout that never happened.
  if (gear.credits <= 0) return 'none';
  if (!gear.unlocked) return 'locked';
  if (gear.claimable) return 'claimable';
  return gear.rewardPending ? 'pending' : 'claimed';
};

/**
 * The reward marker in a card's top-right corner, and again in the long-form
 * view's header, so opening a card never hides what it pays or lets it be claimed.
 * The ONLY thing on a card that knows whether the gear is earned: the card itself
 * stays identical either way - greying the whole card out said "this is spent",
 * when what is spent is the reward.
 */
export const RewardChip = ({
  gear,
  reward: rewardProp,
  onClaim,
  labeled = false,
}: {
  gear: GearStatus;
  reward: RewardState;
  /** Without it a claimable reward reads as locked: nothing here can pay it out. */
  onClaim?: () => void;
  /** For the long-form header, which has the width a card's top row does not. */
  labeled?: boolean;
}) => {
  const isMobile = useIsMobile();
  const reward = rewardProp === 'claimable' && !onClaim ? 'locked' : rewardProp;
  const amount = (clickable: boolean) => (
    <Chip
      size="sm"
      variant="soft"
      color={reward === 'claimable' ? 'success' : 'neutral'}
      startDecorator={<CreditIcon sx={{ fontSize: 12, color: 'var(--Icon-color)' }} />}
      data-testid={`gear-reward-${gear.key}`}
      {...(clickable && {
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onClaim?.();
        },
      })}
      sx={theme => {
        const { ink, stroke, fill, hoverFill, activeFill } =
          reward === 'claimable'
            ? rewardGreen(theme)
            : {
                ink: theme.palette.text.primary,
                stroke: theme.palette.border.muted,
                fill: grayAlpha[150][10],
                hoverFill: grayAlpha[150][10],
                activeFill: grayAlpha[150][10],
              };
        return {
          gap: '6px',
          '--Chip-minHeight': '24px',
          fontSize: '13px',
          backgroundColor: fill,
          // A clickable Chip lays its action button over the root and paints it
          // from these variables, so without them the green under it never shows.
          '--variant-softBg': fill,
          '--variant-softHoverBg': hoverFill,
          '--variant-softActiveBg': activeFill,
          '--variant-softColor': ink,
          '--variant-softHoverColor': ink,
          '--variant-softActiveColor': ink,
          border: `1px solid ${stroke}`,
          color: ink,
          // CreditIcon reads var(--Icon-color), which Joy's
          // variant would otherwise set from its own palette.
          '--Icon-color': ink,
        };
      }}
    >
      {gear.credits.toLocaleString()}
    </Chip>
  );

  // The long-form header has the width a card's top row lacks, so on a desktop
  // a claimable reward is the claim button itself: its label carries the amount,
  // so a chip beside it would only repeat it. A phone's header keeps the chip, with
  // the button in a strip under the header instead (see the Gears page's renderPanel).
  if (labeled && reward === 'claimable' && onClaim && !isMobile) {
    return <ClaimButton gear={gear} onClaim={onClaim} compact />;
  }

  return (
    <>
      {reward === 'pending' && (
        <Tooltip title="Not claimable yet">
          <Chip
            size="sm"
            variant="soft"
            color="warning"
            startDecorator={<CreditIcon sx={{ fontSize: 12, color: 'var(--Icon-color)' }} />}
            data-testid={`gear-pending-${gear.key}`}
            // Joy sets gap as a plain declaration per size (3px on sm), not
            // as a variable, so it is overridden directly.
            sx={theme => ({
              gap: '6px',
              '--Chip-minHeight': '24px',
              fontSize: '13px',
              // The chip's own text colour, as the green and grey chips are
              // stroked in theirs.
              border: `1px solid ${theme.palette.warning.softColor}`,
            })}
          >
            {gear.credits.toLocaleString()}
          </Chip>
        </Tooltip>
      )}
      {reward === 'claimed' && (
        <Tooltip title={`Reward claimed - ${creditText(gear)}`}>
          <Chip
            size="sm"
            variant="soft"
            color="neutral"
            data-testid={`gear-unlocked-${gear.key}`}
            sx={theme => ({
              ...neutralFrame(theme),
              '--Chip-minHeight': '24px',
              // Joy sizes a Chip from its content plus padding-inline and
              // caps it at `max-content`, so a circle needs the padding
              // cancelled, the cap lifted and the width pinned - otherwise
              // the 16px glyph plus the border wins at 18px.
              '--Chip-paddingInline': '0px',
              width: '24px',
              minWidth: '24px',
              maxWidth: '24px',
              borderRadius: '50%',
              justifyContent: 'center',
              color: theme.palette.text.tertiary,
              // Joy's label slot is an inline-block that grows to fill the
              // chip, so the glyph inside it sits on the text baseline
              // rather than in the middle of the circle.
              [`& .${chipClasses.label}`]: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
              },
            })}
          >
            <CheckIcon sx={{ fontSize: '16px', display: 'block' }} />
          </Chip>
        </Tooltip>
      )}
      {/* Locked and claimable share one shape: the neutral frame says "there
                is a reward here", and green is kept for the one state that asks for
                something. */}
      {(reward === 'locked' || reward === 'claimable') && gear.credits > 0 && (
        <Tooltip
          title={
            reward === 'claimable'
              ? `Claim ${creditText(gear)}`
              : `Earn ${creditText(gear)} the first time you use this.`
          }
        >
          {amount(reward === 'claimable')}
        </Tooltip>
      )}
    </>
  );
};

/**
 * The button that pays a claimable reward out, in a footer under a card's CTA
 * and, on a phone, at the top of the open card. The chip beside the title is the
 * status, this is the action. A button rather than a line of text: a text line
 * read as a caption, and on a phone, with no hover to say otherwise, a thumb that
 * missed it landed on the card, which acts or navigates away.
 */
export const ClaimButton = ({
  gear,
  onClaim,
  mt = '16px',
  testId,
  compact = false,
}: {
  gear: GearStatus;
  onClaim: () => void;
  mt?: string;
  testId?: string;
  /** Sized to its label and as tall as the back button beside it, for the open
   *  card's header, so the header does not change height when the reward is claimed. */
  compact?: boolean;
}) => {
  const isMobile = useIsMobile();
  return (
    <Typography
      level="body-xs"
      component="button"
      data-testid={testId ?? `gear-claim-${gear.key}`}
      onClick={event => {
        event.stopPropagation();
        onClaim();
      }}
      onKeyDown={event => event.stopPropagation()}
      sx={theme => {
        const green = rewardGreen(theme);
        return {
          mt: compact ? 0 : mt,
          // A button shrinks to its label outside a flex column, so the width is set
          // outright; the card footer and the open card's strip both want it full.
          width: compact ? 'auto' : '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Taller on a phone, for a thumb; a mouse does not need the extra height.
          minHeight: compact ? '32px' : isMobile ? '40px' : '36px',
          px: '12px',
          py: 0,
          border: `1px solid ${green.stroke}`,
          borderRadius: '6px',
          backgroundColor: green.fill,
          font: 'inherit',
          fontSize: '13px',
          fontWeight: 500,
          color: green.ink,
          cursor: 'pointer',
          '@media (hover: hover)': { '&:hover': { backgroundColor: green.hoverFill } },
          '&:active': { backgroundColor: green.activeFill },
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary[500]}`,
            outlineOffset: '2px',
          },
        };
      }}
    >
      Claim {creditText(gear)}
    </Typography>
  );
};

/**
 * Inline note shown on a card when the payout is held by the trust gate or a
 * gear-specific rewardCheck. Each reason gets its own copy so the user knows
 * what to do, not just that they cannot claim yet.
 */
export const PendingRewardNote = ({ gear }: { gear: GearStatus }) => (
  <Typography
    level="body-xs"
    data-testid={`gear-pending-note-${gear.key}`}
    sx={{ mt: '16px', fontSize: '13px', color: 'warning.softColor' }}
  >
    {gear.pendingReason === 'unverified'
      ? `Verify your email to claim ${creditText(gear)}.`
      : gear.pendingReason === 'too_new'
        ? `Claimable for ${creditText(gear)} once your account is ${gear.minAccountAgeDays ?? GEAR_TRUST_MIN_AGE_DAYS} days old.`
        : `Once someone else opens your artifact link while signed in, you can claim ${creditText(gear)}.`}
  </Typography>
);

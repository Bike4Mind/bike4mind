import { Button, Tooltip } from '@mui/joy';
import { FC, useState } from 'react';
import CreditIcon from '../svgs/icons/CreditIcon';
import { orange } from '@client/app/utils/themes/colors';
import CreditsModal from '../subscription/CreditsModal';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { formatCreditBalance } from '@client/app/utils/formatCredits';
import { LOW_CREDITS_THRESHOLD_DEFAULT } from '@bike4mind/common';
import { useLowCreditsThreshold } from '@client/app/hooks/data/teamPlanSettings';

/**
 * Default threshold below which credits are considered "low". The live value is the
 * `lowCreditsThreshold` admin setting - read it with `useLowCreditsThreshold()`.
 */
export const LOW_CREDITS_THRESHOLD = LOW_CREDITS_THRESHOLD_DEFAULT;

function balanceTooltip(credits: number, lowThreshold: number): string {
  if (credits <= 0) return 'Out of credits. Add credits to keep chatting.';
  if (credits < lowThreshold) return 'Running low. Add credits so your work is not interrupted.';
  return 'Your credit balance. Each answer shows what it cost. Click to add credits or see usage.';
}

/**
 * The balance as quiet text, coloured only when it runs low; no data of its own, so a preview can
 * render any balance. CreditBalanceChip feeds it the live one.
 */
export const CreditBalanceChipView: FC<{ credits: number; lowCreditsThreshold: number; onClick: () => void }> = ({
  credits,
  lowCreditsThreshold,
  onClick,
}) => {
  const color = credits <= 0 ? 'danger' : credits < lowCreditsThreshold ? 'warning' : 'neutral';
  return (
    <Tooltip title={balanceTooltip(credits, lowCreditsThreshold)} placement="top" variant="soft">
      <Button
        size="sm"
        variant="plain"
        color={color}
        onClick={onClick}
        data-testid="credit-balance-chip"
        aria-label={`${formatCreditBalance(credits)}. Open credits`}
        startDecorator={<CreditIcon sx={{ fontSize: 14 }} />}
        sx={{
          height: '24px',
          minHeight: '24px',
          px: 0.75,
          gap: 0.25,
          borderRadius: '6px',
          whiteSpace: 'nowrap',
          fontSize: '12px',
          fontWeight: 400,
          fontVariantNumeric: 'tabular-nums',
          ...(color === 'neutral' && {
            '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
            '--variant-plainHoverColor': 'var(--joy-palette-text-secondary)',
          }),
          // Low: the same orange and neutral hover as Research Mode's no-models state
          // (ResearchModeIndicator), not the paler warning.plainColor.
          ...(color === 'warning' && {
            '--variant-plainColor': orange[450],
            '--variant-plainHoverColor': orange[450],
            '--variant-plainHoverBg': 'var(--joy-palette-neutral-plainHoverBg)',
            '--variant-plainActiveBg': 'var(--joy-palette-neutral-plainActiveBg)',
          }),
        }}
      >
        {formatCreditBalance(credits)}
      </Button>
    </Tooltip>
  );
};

/**
 * Labeled credit balance for the status line above the composer (ComposerStatusLine); opens the
 * credits modal (packages + transaction history). Quiet text at rest, coloured only when the
 * balance runs low. Renders nothing while `enforceCredits` is off, matching the profile menu -
 * nothing decrements then, so a balance would mislead. Uses the display (not live) balance so it
 * holds steady through a turn's reservation dip (see useEffectiveCredits).
 */
const CreditBalanceChip: FC = () => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const credits = useEffectiveCredits();
  const lowCreditsThreshold = useLowCreditsThreshold();
  const [isOpen, setIsOpen] = useState(false);

  if (!enforceCredits) return null;

  return (
    <>
      <CreditBalanceChipView
        credits={credits}
        lowCreditsThreshold={lowCreditsThreshold}
        onClick={() => setIsOpen(true)}
      />
      <CreditsModal open={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};

export default CreditBalanceChip;

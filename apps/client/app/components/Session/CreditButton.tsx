import { Button, Tooltip } from '@mui/joy';
import { FC, useState } from 'react';
import Bike4MindIcon from '../svgs/icons/Bike4MindIcon';
import CreditsModal from '../subscription/CreditsModal';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { formatCreditBalance } from '@client/app/utils/formatCredits';

/**
 * Threshold below which credits are considered "low".
 * Used by CreditBalanceChip (warning colour), LowCreditsWarning and CreditsModal.
 */
export const LOW_CREDITS_THRESHOLD = 1000;

function balanceTooltip(credits: number): string {
  if (credits <= 0) return 'Out of credits. Add credits to keep chatting.';
  if (credits < LOW_CREDITS_THRESHOLD) return 'Running low. Add credits so your work is not interrupted.';
  return 'Your credit balance. Each answer shows what it cost. Click to add credits or see usage.';
}

/**
 * Always-visible, labeled credit balance for the composer toolbar; opens the credits modal
 * (packages + transaction history). Renders nothing while `enforceCredits` is off, matching the
 * profile menu - nothing decrements then, so a balance would mislead. Uses the display (not
 * live) balance so it holds steady through a turn's reservation dip (see useEffectiveCredits).
 */
const CreditBalanceChip: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const credits = useEffectiveCredits();
  const [isOpen, setIsOpen] = useState(false);

  if (!enforceCredits) return null;

  const color = credits <= 0 ? 'danger' : credits < LOW_CREDITS_THRESHOLD ? 'warning' : 'neutral';
  const label = formatCreditBalance(credits, compact);

  return (
    <>
      <Tooltip title={balanceTooltip(credits)} placement="top" variant="soft">
        <Button
          size="sm"
          variant="outlined"
          color={color}
          onClick={() => setIsOpen(true)}
          data-testid="credit-balance-chip"
          aria-label={`${formatCreditBalance(credits)}. Open credits`}
          startDecorator={<Bike4MindIcon size="14" fill="currentColor" />}
          sx={{
            height: '32px',
            minHeight: '32px',
            px: 1.25,
            borderRadius: '6px',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            fontWeight: 500,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {label}
        </Button>
      </Tooltip>
      <CreditsModal open={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
};

export default CreditBalanceChip;

import { useState } from 'react';
import { styled } from '@mui/system';
import { FirstRunEvents } from '@bike4mind/common';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useLowCreditsThreshold } from '@client/app/hooks/data/teamPlanSettings';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import BillingModal from '@client/app/components/subscription/BillingModal';
import { formatCreditBalance } from '@client/app/utils/formatCredits';
import StudioCostPill from '../design/StudioCostPill';
import { STUDIO_FOCUS_VISIBLE, studioRadius } from '../design/studioTokens';

const BalanceButton = styled('button')({
  padding: 0,
  border: 0,
  background: 'none',
  borderRadius: studioRadius('pill'),
  cursor: 'pointer',
  '&:focus-visible': STUDIO_FOCUS_VISIBLE,
});

/**
 * The Studio header's credit balance; opens the credits modal, like the composer's CreditBalanceChip
 * (Session/CreditButton.tsx), whose rules it follows: nothing while `enforceCredits` is off, the
 * display (not live) balance, warm once it runs low.
 */
const StudioCreditsBalance = () => {
  const enforceCredits = !!useGetSettingsValue('enforceCredits');
  const credits = useEffectiveCredits();
  const lowCreditsThreshold = useLowCreditsThreshold();
  const { mutate: logEvent } = useLogEvent();
  const [isOpen, setIsOpen] = useState(false);

  if (!enforceCredits) return null;

  return (
    <>
      <BalanceButton
        type="button"
        aria-label={`${formatCreditBalance(credits)}. See plans and top up`}
        onClick={() => {
          logEvent({ type: FirstRunEvents.CREDITS_CHIP_CLICKED });
          setIsOpen(true);
        }}
        data-testid="studio-credits-balance"
      >
        <StudioCostPill
          amount={credits}
          unit="credits"
          variant="pill"
          tone={credits < lowCreditsThreshold ? 'low' : 'default'}
          testId="studio-credits-balance-amount"
        />
      </BalanceButton>
      <BillingModal open={isOpen} entry="credits_chip" onClose={() => setIsOpen(false)} />
    </>
  );
};

export default StudioCreditsBalance;

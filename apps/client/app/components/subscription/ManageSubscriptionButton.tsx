import { Button } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import { useOpenUserStripePortal } from './useOpenUserStripePortal';

type ManageSubscriptionButtonProps = {
  /** Solid when the plan's payment failed: fixing the card is the action the user needs. */
  isPrimaryAction: boolean;
};

const ManageSubscriptionButton = ({ isPrimaryAction }: ManageSubscriptionButtonProps) => {
  const { t } = useTranslation();
  const stripePortal = useOpenUserStripePortal();

  if (!stripePortal.isAvailable) return null;

  return (
    <Button
      data-testid="plan-card-manage-subscription-btn"
      color="primary"
      variant={isPrimaryAction ? 'solid' : 'outlined'}
      loading={stripePortal.isPending}
      onClick={stripePortal.open}
    >
      {t('profile.manage_subscription')}
    </Button>
  );
};

export default ManageSubscriptionButton;

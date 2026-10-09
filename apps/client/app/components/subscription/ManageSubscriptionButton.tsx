import { useUser } from '@client/app/contexts/UserContext';
import { useStripePortal } from '@client/app/hooks/data/stripe';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { Button } from '@mui/joy';
import { useTranslation } from 'react-i18next';

type ManageSubscriptionButtonProps = {
  /** Solid when the plan's payment failed: fixing the card is the action the user needs. */
  isPrimaryAction: boolean;
};

const ManageSubscriptionButton = ({ isPrimaryAction }: ManageSubscriptionButtonProps) => {
  const { t } = useTranslation();
  const { currentUser } = useUser();
  const stripePortal = useStripePortal();

  if (!currentUser) return null;

  const handleClick = () => {
    stripePortal.mutate(
      { ownerType: SubscriptionOwnerType.User, ownerId: currentUser.id },
      {
        // Store the return path only on success so a failed mutation doesn't leave an
        // orphaned key that causes a spurious redirect on the next "/" load (see router.tsx).
        onSuccess: () => {
          sessionStorage.setItem('__stripe_return', `${window.location.pathname}${window.location.search}`);
        },
      }
    );
  };

  return (
    <Button
      data-testid="plan-card-manage-subscription-btn"
      color="primary"
      variant={isPrimaryAction ? 'solid' : 'outlined'}
      loading={stripePortal.isPending}
      onClick={handleClick}
    >
      {t('profile.manage_subscription')}
    </Button>
  );
};

export default ManageSubscriptionButton;

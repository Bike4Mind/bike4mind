import { useCancelSubscription, useChangeSubscription, useSubscribePlan } from '@client/app/hooks/data/subscriptions';
import { IUserSubscription } from '@client/lib/userSubscriptions/types';
import { Button } from '@mui/joy';
import dayjs from 'dayjs';
import { ComponentProps, useMemo } from 'react';

interface SubscribeButtonProps {
  priceId: string;
  /**
   * The user's non-terminal subscriptions. A delinquent (past_due/unpaid) row is
   * deliberately included: it is still the subscription they need to cancel, and
   * holding it back is what left a dunned user with no way to stop the emails.
   */
  cancellableSubscriptions: IUserSubscription[];
}

const SubscribeButton = ({ priceId, cancellableSubscriptions }: SubscribeButtonProps) => {
  const subscribe = useSubscribePlan();
  const cancelSubscription = useCancelSubscription();
  const changeSubscription = useChangeSubscription();

  const type: 'subscribe' | 'cancel' | 'change' = useMemo(() => {
    const activeSubscription = cancellableSubscriptions.find(subscription => subscription.priceId === priceId);
    if (activeSubscription) {
      return 'cancel';
    } else if (cancellableSubscriptions.length > 0) {
      return 'change';
    } else {
      return 'subscribe';
    }
  }, [cancellableSubscriptions, priceId]);

  const activeSubscription = cancellableSubscriptions.find(subscription => subscription.priceId === priceId);

  const handleClick = () => {
    switch (type) {
      case 'subscribe':
        return subscribe.mutate(
          { priceId, callbackUrl: window.location.href },
          {
            onSuccess: data => {
              window.location.href = data.sessionUrl;
            },
          }
        );
      case 'cancel':
        return cancelSubscription.mutate(priceId);
      case 'change':
        return changeSubscription.mutate({
          priceId,
          callbackUrl: window.location.href,
        });
    }
  };

  // If canceled, show when the subscription will end based on the periodEndsAt date
  if (activeSubscription?.canceledAt) {
    return (
      <Button className="subscription-ends-button" disabled>
        Subscription ends on {dayjs(activeSubscription.periodEndsAt).format('MMMM D, YYYY')}
      </Button>
    );
  }

  const isLoading = subscribe.isPending || cancelSubscription.isPending || changeSubscription.isPending;

  const buttonText =
    type === 'subscribe' ? 'Subscribe' : type === 'cancel' ? 'Cancel Subscription' : 'Change Subscription';
  const buttonProps: ComponentProps<typeof Button> = {
    color: type === 'subscribe' ? 'neutral' : type === 'cancel' ? 'neutral' : 'primary',
    variant: type === 'subscribe' ? 'solid' : type === 'cancel' ? 'outlined' : 'solid',
  };

  return (
    <Button className="subscription-action-button" loading={isLoading} onClick={handleClick} {...buttonProps}>
      {buttonText}
    </Button>
  );
};
export default SubscribeButton;

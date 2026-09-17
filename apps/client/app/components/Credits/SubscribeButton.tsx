import { useCancelSubscription, useChangeSubscription, useSubscribePlan } from '@client/app/hooks/data/subscriptions';
import { pickSubscriptionByPrice } from '@client/lib/subscriptions/types';
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

  // Active-first per price, so a stale delinquent row at this price cannot shadow the
  // plan the user is paying for and show them a stale "ends on" date instead.
  const activeSubscription = useMemo(
    () => pickSubscriptionByPrice(cancellableSubscriptions, priceId),
    [cancellableSubscriptions, priceId]
  );

  const type: 'subscribe' | 'cancel' | 'change' = useMemo(() => {
    if (activeSubscription) {
      return 'cancel';
    } else if (cancellableSubscriptions.some(sub => sub.status === 'active')) {
      // The affordance requires an active plan to change from; a delinquent,
      // trialing or paused row falls through to Subscribe. The change route itself
      // no longer requires an active row (it acts on the displayed plan), so this
      // is the button's own rule rather than a mirror of that lookup.
      return 'change';
    } else {
      return 'subscribe';
    }
  }, [activeSubscription, cancellableSubscriptions]);

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

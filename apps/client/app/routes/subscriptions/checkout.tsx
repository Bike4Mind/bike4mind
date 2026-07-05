import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue, useSettingsFromServer } from '@client/app/hooks/data/settings';
import { useSubscribePlan } from '@client/app/hooks/data/subscriptions';
import { LinearProgress } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';

/**
 * Redirects to the Stripe checkout page for the selected subscription plan.
 * If the user is not logged in, redirects to register with the plan ID as a query param.
 */
const SubscriptionsCheckoutPage = () => {
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const plan = (search as any)?.plan;
  const subscribe = useSubscribePlan();
  const settings = useSettingsFromServer();
  const enforceCredits = useGetSettingsValue('enforceCredits');

  useEffect(() => {
    if (subscribe.isPending || settings.isPending || subscribe.isSuccess || subscribe.isError) {
      return;
    }

    if (!plan || !enforceCredits) {
      navigate({ to: '/' });
      return;
    }

    if (!currentUser) {
      navigate({ to: `/register?redirectTo=/subscriptions/checkout?plan=${plan}` });
      return;
    } else {
      subscribe.mutate(
        {
          priceId: plan as string,
          callbackUrl: `${window.location.origin}`,
        },
        {
          onSuccess: data => {
            window.location.href = data.sessionUrl;
          },
          onError: () => {
            navigate({ to: '/' });
          },
        }
      );
    }
  }, [currentUser, navigate, subscribe, enforceCredits, settings, plan]);

  return <LinearProgress />;
};

export default SubscriptionsCheckoutPage;

import { useUser } from '@client/app/contexts/UserContext';
import { useStripePortal } from '@client/app/hooks/data/stripe';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';

/**
 * Opens the Stripe billing portal for the signed-in user's own subscription. Shared by every
 * personal-plan entry point so they all return the user to the exact page (path + query) they left.
 */
export function useOpenUserStripePortal() {
  const { currentUser } = useUser();
  const stripePortal = useStripePortal();

  const open = () => {
    if (!currentUser) return;
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

  return { open, isPending: stripePortal.isPending, isAvailable: !!currentUser };
}

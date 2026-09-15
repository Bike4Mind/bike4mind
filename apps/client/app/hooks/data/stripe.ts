import { api } from '@client/app/contexts/ApiContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { getErrorMessage } from '@client/app/utils/error';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import Stripe from 'stripe';

export function useStripePortal() {
  return useMutation({
    mutationFn: async ({ ownerType, ownerId }: { ownerType: SubscriptionOwnerType; ownerId: string }) => {
      // Use origin (root path) so CloudFront can serve the SPA's index.html on return.
      // Callers must store '__stripe_return' in sessionStorage before invoking so the
      // router can restore the intended destination after Stripe redirects back.
      const response = await api.post<{ url: string }>('/api/stripe/portal', {
        callbackUrl: window.location.origin,
        ownerType,
        ownerId,
      });
      return response.data;
    },
    onSuccess: ({ url }) => {
      window.location.href = url;
    },
    onError: error => {
      toast.error(getErrorMessage(error));
    },
  });
}

export function useGetSubscriptionPlans() {
  const enforceCredits = useGetSettingsValue('enforceCredits');

  return useQuery({
    queryKey: ['stripe', 'subscription-plans'],
    queryFn: async () => {
      const response = await api.get<Stripe.Price[]>('/api/stripe/subscription-plans');
      return response.data;
    },
    staleTime: 1000 * 60 * 60 * 1, // 1 hour
    // Don't fetch subscription plans if enforceCredits is false
    enabled: typeof enforceCredits === 'boolean' && enforceCredits,
  });
}

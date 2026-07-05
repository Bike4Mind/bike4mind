import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

/**
 * Handles Stripe Checkout success redirects globally (subscription checkout success).
 */
const StripeCheckoutSuccessHandler = () => {
  const queryClient = useQueryClient();

  useEffect(() => {
    // Use URLSearchParams instead of useSearch to avoid router context dependency
    const searchParams = new URLSearchParams(window.location.search);
    const subscriptionSuccess = searchParams.get('subscription_success');

    if (subscriptionSuccess === 'true') {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['subscriptions'] });

      toast.success('Subscription completed successfully!');

      // Clean up URL without triggering a refresh
      const newUrl = window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, [queryClient]);

  return null;
};

export default StripeCheckoutSuccessHandler;

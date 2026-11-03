import { toast } from 'sonner';

/**
 * Warns when a single suspend or delete response says some Stripe subscriptions could not be
 * canceled. The account change itself went through, so the admin has to finish the cancel in Stripe.
 */
export const warnSubscriptionCancelFailures = (response: unknown): void => {
  if (typeof response !== 'object' || response === null || !('subscriptionCancellation' in response)) return;
  const cancellation = response.subscriptionCancellation;
  if (typeof cancellation !== 'object' || cancellation === null || !('failed' in cancellation)) return;
  const { failed } = cancellation;
  if (Array.isArray(failed) && failed.length > 0) {
    toast.warning(
      `Could not cancel ${failed.length.toLocaleString()} Stripe subscription(s) of this account. Cancel them in Stripe.`
    );
  }
};

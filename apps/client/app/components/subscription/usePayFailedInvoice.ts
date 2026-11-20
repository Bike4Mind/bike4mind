import { useEffect, useRef, useState } from 'react';
import { isAxiosError } from 'axios';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@client/app/contexts/ApiContext';
import { getErrorMessage } from '@client/app/utils/error';
import type { PayInvoiceResult } from '@client/pages/api/subscriptions/pay-invoice';

// The plan flips back to active only when Stripe's webhook lands, which can trail the charge.
const WEBHOOK_LAG_REFETCH_MS = 5000;

/** Charges the open invoice on a delinquent Stripe subscription (POST /api/subscriptions/pay-invoice). */
export function usePayFailedInvoice() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [declineMessage, setDeclineMessage] = useState<string | null>(null);
  const [isPaid, setIsPaid] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(refetchTimer.current), []);

  const refreshSubscriptions = () => {
    queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
    queryClient.invalidateQueries({ queryKey: ['organizations'] });
  };

  const mutation = useMutation({
    mutationFn: async (subscriptionId: string) => {
      const { data } = await api.post<PayInvoiceResult>('/api/subscriptions/pay-invoice', { subscriptionId });
      return data;
    },
    onMutate: () => setDeclineMessage(null),
    onSuccess: result => {
      if (result.status === 'requires_action') {
        window.location.assign(result.hostedInvoiceUrl);
        return;
      }
      setIsPaid(true);
      toast.success(t('profile.pay_now_success'));
      refreshSubscriptions();
      clearTimeout(refetchTimer.current);
      // Re-enable the button too, so a webhook that never lands does not leave it stuck on "Payment received".
      refetchTimer.current = setTimeout(() => {
        setIsPaid(false);
        refreshSubscriptions();
      }, WEBHOOK_LAG_REFETCH_MS);
    },
    onError: error => {
      if (isAxiosError(error) && error.response?.status === 402) {
        setDeclineMessage(getErrorMessage(error));
        return;
      }
      toast.error(getErrorMessage(error));
    },
  });

  return {
    pay: (subscriptionId: string) => mutation.mutate(subscriptionId),
    // A redirect keeps the mutation "successful" while the page unloads; stay disabled through it.
    isPending: mutation.isPending || (mutation.isSuccess && mutation.data?.status === 'requires_action'),
    isPaid,
    declineMessage,
  };
}

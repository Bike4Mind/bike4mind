import { api } from '@client/app/contexts/ApiContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { PaymentPayload, TransactionType } from '@client/lib/credits/types';
import { Button } from '@mui/joy';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import PaymentModal from './PaymentModal';
import { getErrorMessage } from '@client/app/utils/error';

interface IPaymentButtonProps {
  onPayment: () => void;
}

/*
 * Buy-credits button with a two-phase open: pressing it sets `wantOpen`, which triggers
 * a fetch of the client secret from the backend; once fetched it sets `open`, which loads
 * StripeJS and shows the CheckoutForm payment pop-over.
 */
const PaymentButton: FC<IPaymentButtonProps & PaymentPayload> = ({ onPayment, ...rest }) => {
  const [wantOpen, setWantOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const pricePerCredit = useGetSettingsValue('pricePerCredit');
  const hasPricePerCredit = typeof pricePerCredit === 'number';
  const isPricePerCreditSettingRequired = rest.transactionType === TransactionType.PerCredit && !hasPricePerCredit;

  const productName = useMemo(() => {
    switch (rest.transactionType) {
      case TransactionType.PerCredit:
        return `${rest.credits.toLocaleString()} Credits`;
      case TransactionType.Package: {
        const packageInfo = CREDIT_PACKAGES[rest.packageId];
        return `${packageInfo.credits.toLocaleString()} Credits Package`;
      }
      default:
        return 'Unknown Subscription Plan';
    }
  }, [rest]);

  const handleClose = useCallback(() => {
    setWantOpen(false);
    setOpen(false);
    setStripePromise(null);
    setClientSecret(null);
  }, []);

  // On button open, start the payment process by fetching the client secret
  useEffect(() => {
    if (wantOpen && !open) {
      // Collect PaymentIntent.clientSecret from the backend
      api
        .post('/api/stripe/start-payment', rest, { withCredentials: true })
        .then(response => {
          if (response.data.publishableKey && !stripePromise) {
            setStripePromise(loadStripe(response.data.publishableKey));
          }
          if (response.data.clientSecret) {
            setClientSecret(response.data.clientSecret);
            // Open the payment pop-over
            setOpen(true);
          }
        })
        .catch(error => {
          console.error('Failed to start payment', error);
          toast.error(getErrorMessage(error));
          setWantOpen(false);
        });
    } else if (!wantOpen && open) {
      setStripePromise(null);
      setClientSecret(null);
      setOpen(false);
    }
  }, [wantOpen, open, rest, stripePromise]);

  if (isPricePerCreditSettingRequired) {
    return <>Missing pricePerCredit Admin Setting!</>;
  }

  return (
    <>
      <Button
        className="credits-modal-payment-button"
        onClick={() => setWantOpen(true)}
        disabled={wantOpen || open || isPricePerCreditSettingRequired}
      >
        Purchase
      </Button>

      {stripePromise && clientSecret && (
        <PaymentModal
          isOpen={open}
          onClose={handleClose}
          stripePromise={stripePromise}
          clientSecret={clientSecret}
          productName={productName}
          onPayment={onPayment}
        />
      )}
    </>
  );
};

export default PaymentButton;

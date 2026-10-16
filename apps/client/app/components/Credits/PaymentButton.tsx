import { CreditPurchaseConfirmOutcome, CreditPurchaseEvents } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { PaymentPayload, TransactionType } from '@client/lib/credits/types';
import { Button } from '@mui/joy';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import { isAxiosError } from 'axios';
import { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import PaymentModal from './PaymentModal';
import type { ConfirmResult } from './CheckoutForm';
import { getErrorMessage } from '@client/app/utils/error';
import { formatCreditAmount } from '@client/app/utils/formatCredits';

interface IPaymentButtonProps {
  onPayment: () => void;
  /** Accessible name naming what this buys; the visible label defaults to a bare "Purchase". */
  ariaLabel?: string;
  /** Visible label; presentation only, the checkout is driven by the payload. */
  label?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/*
 * Buy-credits button with a two-phase open: pressing it sets `wantOpen`, which triggers
 * a fetch of the client secret from the backend; once fetched it sets `open`, which loads
 * StripeJS and shows the CheckoutForm payment pop-over.
 *
 * Each step is recorded as a CreditPurchaseEvents analytics event keyed by the payment intent id,
 * so a "paid and got nothing" claim can be traced through to the webhook's grant.
 */
const PaymentButton: FC<IPaymentButtonProps & PaymentPayload> = ({ onPayment, ariaLabel, label, size, ...rest }) => {
  const [wantOpen, setWantOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const { mutate: logEvent } = useLogEvent();
  const paymentIntentIdRef = useRef<string | null>(null);
  const lastOutcomeRef = useRef<CreditPurchaseConfirmOutcome | undefined>(undefined);
  const pricePerCredit = useGetSettingsValue('pricePerCredit');
  const hasPricePerCredit = typeof pricePerCredit === 'number';
  const isPricePerCreditSettingRequired = rest.transactionType === TransactionType.PerCredit && !hasPricePerCredit;
  // `rest` is a new object every render, so the start effect keys on these primitives and rebuilds
  // the payload from them; depending on `rest` re-ran it on any re-render (the CHECKOUT_REQUESTED
  // mutation causes several) and posted start-payment once per pass.
  const { transactionType } = rest;
  const packageId = rest.transactionType === TransactionType.Package ? rest.packageId : undefined;
  const perCredits = rest.transactionType === TransactionType.PerCredit ? rest.credits : undefined;
  // One request per Buy click: `inFlightRef` blocks re-entry while a start is pending, and a response
  // whose attempt id is no longer current (the form was closed, or a later attempt began) is ignored.
  const inFlightRef = useRef(false);
  const attemptRef = useRef(0);

  const productName = useMemo(() => {
    switch (rest.transactionType) {
      case TransactionType.PerCredit:
        return `${formatCreditAmount(rest.credits)} Credits`;
      case TransactionType.Package: {
        const packageInfo = CREDIT_PACKAGES[rest.packageId];
        return `${formatCreditAmount(packageInfo.credits)} Credits Package`;
      }
      default:
        return 'Unknown Subscription Plan';
    }
  }, [rest]);

  const handleStart = useCallback(() => {
    logEvent({
      type: CreditPurchaseEvents.CHECKOUT_REQUESTED,
      metadata: {
        transactionType: rest.transactionType,
        ...(rest.transactionType === TransactionType.Package && { packageId: rest.packageId }),
        ...(rest.transactionType === TransactionType.PerCredit && { credits: rest.credits }),
      },
    });
    setWantOpen(true);
  }, [logEvent, rest]);

  const handleConfirmResult = useCallback(
    (result: ConfirmResult) => {
      lastOutcomeRef.current = result.outcome;
      const paymentIntentId = paymentIntentIdRef.current;
      if (!paymentIntentId) return;
      logEvent({ type: CreditPurchaseEvents.PAYMENT_CONFIRM_RESULT, metadata: { paymentIntentId, ...result } });
    },
    [logEvent]
  );

  const handleClose = useCallback(() => {
    const paymentIntentId = paymentIntentIdRef.current;
    const lastOutcome = lastOutcomeRef.current;
    // requires_action is pending on the customer's side (e.g. bank instructions), not abandoned.
    if (
      paymentIntentId &&
      lastOutcome !== 'succeeded' &&
      lastOutcome !== 'processing' &&
      lastOutcome !== 'requires_action'
    ) {
      logEvent({
        type: CreditPurchaseEvents.PAYMENT_ABANDONED,
        metadata: { paymentIntentId, ...(lastOutcome && { lastOutcome }) },
      });
    }
    paymentIntentIdRef.current = null;
    lastOutcomeRef.current = undefined;
    attemptRef.current += 1;
    inFlightRef.current = false;
    setWantOpen(false);
    setOpen(false);
    setStripePromise(null);
    setClientSecret(null);
  }, [logEvent]);

  // On button open, start the payment process by fetching the client secret
  useEffect(() => {
    if (wantOpen && !open) {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const attempt = ++attemptRef.current;
      const payload: PaymentPayload =
        transactionType === TransactionType.Package
          ? { transactionType, packageId: packageId as NonNullable<typeof packageId> }
          : { transactionType, credits: perCredits as number };
      // Collect PaymentIntent.clientSecret from the backend
      api
        .post('/api/stripe/start-payment', payload, { withCredentials: true })
        .then(response => {
          if (attempt !== attemptRef.current) return;
          inFlightRef.current = false;
          if (response.data.publishableKey && !stripePromise) {
            setStripePromise(loadStripe(response.data.publishableKey));
          }
          if (response.data.clientSecret) {
            if (response.data.paymentIntentId) {
              paymentIntentIdRef.current = response.data.paymentIntentId;
              logEvent({
                type: CreditPurchaseEvents.PAYMENT_FORM_OPENED,
                metadata: { paymentIntentId: response.data.paymentIntentId },
              });
            }
            setClientSecret(response.data.clientSecret);
            // Open the payment pop-over
            setOpen(true);
          }
        })
        .catch(error => {
          if (attempt !== attemptRef.current) return;
          inFlightRef.current = false;
          console.error('Failed to start payment', error);
          logEvent({
            type: CreditPurchaseEvents.CHECKOUT_START_FAILED,
            metadata: {
              transactionType: payload.transactionType,
              ...(isAxiosError(error) && error.response && { httpStatus: error.response.status }),
            },
          });
          toast.error(getErrorMessage(error));
          setWantOpen(false);
        });
    } else if (!wantOpen && open) {
      setStripePromise(null);
      setClientSecret(null);
      setOpen(false);
    }
    // packageId/perCredits are deliberate deps: a changed purchase is a new checkout once idle.
  }, [wantOpen, open, transactionType, packageId, perCredits, stripePromise, logEvent]);

  if (isPricePerCreditSettingRequired) {
    return <>Missing pricePerCredit Admin Setting!</>;
  }

  return (
    <>
      <Button
        className="credits-modal-payment-button"
        data-testid="credits-purchase-btn"
        aria-label={ariaLabel}
        size={size}
        onClick={handleStart}
        disabled={wantOpen || open || isPricePerCreditSettingRequired}
      >
        {label ?? 'Purchase'}
      </Button>

      {stripePromise && clientSecret && (
        <PaymentModal
          isOpen={open}
          onClose={handleClose}
          stripePromise={stripePromise}
          clientSecret={clientSecret}
          productName={productName}
          onPayment={onPayment}
          onConfirmResult={handleConfirmResult}
        />
      )}
    </>
  );
};

export default PaymentButton;

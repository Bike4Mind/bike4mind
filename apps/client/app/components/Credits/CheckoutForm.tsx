import { FC, useCallback, useEffect, useRef, useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Button } from '@mui/joy';
import type { CreditPurchaseConfirmOutcome } from '@bike4mind/common';
import { reportCreditPurchaseConversion } from '@client/app/components/stripe/StripePaymentReturnHandler';

export interface ConfirmResult {
  outcome: CreditPurchaseConfirmOutcome;
  errorType?: string;
  errorCode?: string;
  declineCode?: string;
}

interface ICheckoutFormProps {
  clientSecret: string;
  onPayment: () => void;
  onPaymentPending?: () => void;
  onConfirmResult?: (result: ConfirmResult) => void;
}

// Some methods (bank transfer instructions, microdeposit verification) finish outside this form,
// so a requires_action confirm without an error is pending, not failed.
const PENDING_ACTION_MESSAGE = 'Your payment needs one more step. Follow the instructions from your payment provider.';

const AUTHENTICATION_FAILED_MESSAGE =
  'We could not verify your card with your bank, so you have not been charged. Try again, or use a different card.';
const AUTHENTICATION_FAILURE_CODE = 'payment_intent_authentication_failure';

function toOutcome(status: string | undefined): CreditPurchaseConfirmOutcome {
  return status === 'succeeded' || status === 'processing' || status === 'requires_action' ? status : 'unknown';
}

const CheckoutForm: FC<ICheckoutFormProps> = ({ clientSecret, onPayment, onPaymentPending, onConfirmResult }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  // Once the intent has succeeded or is processing, a second confirm only returns an
  // unexpected-state error, which would replace the success message and trace as a failure.
  const [isSettled, setIsSettled] = useState(false);
  // Callers pass an inline onPayment, so the status effect below re-runs on every parent render;
  // without this an in-page success would re-announce itself each time.
  const paidRef = useRef(false);
  const notifyPaid = useCallback(() => {
    if (paidRef.current) return;
    paidRef.current = true;
    onPayment();
  }, [onPayment]);

  const pendingRef = useRef(false);
  const notifyPending = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    onPaymentPending?.();
  }, [onPaymentPending]);

  // Retrieve purchase status from Stripe
  useEffect(() => {
    if (!stripe || !clientSecret) return;

    stripe.retrievePaymentIntent(clientSecret).then(({ paymentIntent }) => {
      switch (paymentIntent?.status) {
        case 'succeeded':
          setMessage('Payment succeeded!');
          setIsSettled(true);
          notifyPaid();
          break;
        case 'processing':
          notifyPending();
          setMessage('Your payment is processing.');
          setIsSettled(true);
          break;
        case 'requires_action':
          notifyPending();
          setMessage(PENDING_ACTION_MESSAGE);
          break;
        case 'requires_payment_method':
          // A 3-D Secure challenge failed on the bank's redirect page lands back here in this state.
          setMessage(
            paymentIntent.last_payment_error?.code === AUTHENTICATION_FAILURE_CODE ? AUTHENTICATION_FAILED_MESSAGE : ''
          );
          break;
        default:
          setMessage('Something went wrong.');
          break;
      }
    });
  }, [clientSecret, notifyPaid, notifyPending, stripe]);

  const handleSubmit: (event: React.MouseEvent<HTMLButtonElement>) => void = useCallback(
    async e => {
      if (!stripe || !elements) {
        console.error(`Stripe not loaded`);
        return;
      }

      setIsLoading(true);

      // 'if_required' keeps card payments in-page so the result is observable here; methods that
      // need a redirect (e.g. iDEAL) still go to return_url and are traced by the webhook instead.
      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: window.location.toString(),
        },
        redirect: 'if_required',
      });

      if (error) {
        onConfirmResult?.({
          outcome: 'error',
          errorType: error.type,
          errorCode: error.code,
          declineCode: error.decline_code,
        });
        if (error.code === AUTHENTICATION_FAILURE_CODE) {
          setMessage(AUTHENTICATION_FAILED_MESSAGE);
        } else if (error.type === 'card_error' || error.type === 'validation_error') {
          setMessage(error.message ?? null);
        } else {
          setMessage('An unexpected error occurred.');
        }
      } else {
        onConfirmResult?.({ outcome: toOutcome(paymentIntent?.status) });
        if (paymentIntent?.status === 'succeeded') {
          setMessage('Payment succeeded!');
          setIsSettled(true);
          notifyPaid();
          // A card success no longer redirects, so StripePaymentReturnHandler never sees it.
          reportCreditPurchaseConversion(paymentIntent.id);
        } else if (paymentIntent?.status === 'processing') {
          notifyPending();
          setMessage('Your payment is processing.');
          setIsSettled(true);
        } else if (paymentIntent?.status === 'requires_action') {
          notifyPending();
          setMessage(PENDING_ACTION_MESSAGE);
          setIsSettled(true);
        } else if (paymentIntent?.status === 'requires_payment_method') {
          // A failed or cancelled 3-D Secure challenge returns the intent here without an error.
          setMessage(AUTHENTICATION_FAILED_MESSAGE);
        } else {
          setMessage('Something went wrong.');
        }
      }

      setIsLoading(false);
    },
    [elements, notifyPaid, notifyPending, onConfirmResult, stripe]
  );

  return (
    <form id="payment-form" className="checkout-form">
      <PaymentElement id="payment-element" className="checkout-payment-element" options={{ layout: 'tabs' }} />
      <Button
        className="checkout-submit-button"
        data-testid="checkout-submit-btn"
        disabled={isLoading || isSettled || !stripe || !elements}
        id="submit"
        onClick={handleSubmit}
        sx={{ mt: 2, mb: 2 }}
      >
        <span id="button-text">{isLoading ? 'Loading...' : 'Pay now'}</span>
      </Button>
      {/* Show any error or success messages */}
      {message && (
        <div id="payment-message" className="checkout-payment-message" data-testid="checkout-payment-message">
          {message}
        </div>
      )}
    </form>
  );
};

export default CheckoutForm;

import { FC, useCallback, useEffect, useState } from 'react';
import { PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { Button } from '@mui/joy';

interface ICheckoutFormProps {
  clientSecret: string;
  onPayment: () => void;
}

const CheckoutForm: FC<ICheckoutFormProps> = ({ clientSecret, onPayment }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [message, setMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Retrieve purchase status from Stripe
  useEffect(() => {
    if (!stripe || !clientSecret) return;

    stripe.retrievePaymentIntent(clientSecret).then(({ paymentIntent }) => {
      switch (paymentIntent?.status) {
        case 'succeeded':
          setMessage('Payment succeeded!');
          onPayment();
          break;
        case 'processing':
          setMessage('Your payment is processing.');
          break;
        case 'requires_payment_method':
          setMessage('');
          break;
        default:
          setMessage('Something went wrong.');
          break;
      }
    });
  }, [clientSecret, onPayment, stripe]);

  const handleSubmit: (event: React.MouseEvent<HTMLButtonElement>) => void = useCallback(
    async e => {
      if (!stripe || !elements) {
        console.error(`Stripe not loaded`);
        return;
      }

      setIsLoading(true);

      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: window.location.toString(),
        },
      });

      // Only reached if confirmPayment errors immediately; otherwise Stripe redirects the
      // customer to return_url (some methods like iDEAL redirect via an intermediate site first).
      if (error.type === 'card_error' || error.type === 'validation_error') {
        setMessage(error.message ?? null);
      } else {
        setMessage('An unexpected error occurred.');
      }

      setIsLoading(false);
    },
    [elements, stripe]
  );

  return (
    <form id="payment-form" className="checkout-form">
      <PaymentElement id="payment-element" className="checkout-payment-element" options={{ layout: 'tabs' }} />
      <Button
        className="checkout-submit-button"
        disabled={isLoading || !stripe || !elements}
        id="submit"
        onClick={handleSubmit}
        sx={{ mt: 2, mb: 2 }}
      >
        <span id="button-text">{isLoading ? 'Loading...' : 'Pay now'}</span>
      </Button>
      {/* Show any error or success messages */}
      {message && (
        <div id="payment-message" className="checkout-payment-message">
          {message}
        </div>
      )}
    </form>
  );
};

export default CheckoutForm;

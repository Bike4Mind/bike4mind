import { useId, useRef, useState } from 'react';
import { Alert, Box, Button, Checkbox, Modal, ModalClose, ModalDialog, Typography } from '@mui/joy';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { getTurnstileToken, TurnstileCancelledError } from '@client/app/utils/turnstile';
import {
  getCardVerificationErrorMessage,
  useCardVerificationOffer,
  useCompleteCardVerification,
  useRefreshCardVerification,
  useRemoveCardVerification,
  useStartCardVerification,
} from '@client/app/hooks/data/cardVerification';

function VerificationForm({
  verificationId,
  complete,
}: {
  verificationId: string;
  complete: (id: string) => Promise<void>;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  // State lags a render; a ref blocks a second submit in the same tick.
  const busyRef = useRef(false);
  const [message, setMessage] = useState('');
  return (
    <Box
      component="form"
      onSubmit={async event => {
        event.preventDefault();
        if (!stripe || !elements || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        try {
          const result = await stripe.confirmSetup({
            elements,
            redirect: 'if_required',
            confirmParams: { return_url: window.location.origin },
          });
          if (result.error) {
            setMessage(result.error.message ?? 'Verification failed.');
            return;
          }
          await complete(verificationId);
        } catch (error) {
          setMessage(getCardVerificationErrorMessage(error));
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      }}
    >
      <PaymentElement options={{ wallets: { applePay: 'never', googlePay: 'never' } }} />
      <Button
        type="submit"
        data-testid="card-verification-confirm-btn"
        loading={busy}
        disabled={!stripe || !elements}
        sx={{ mt: 2 }}
      >
        Verify card - no charge
      </Button>
      {message && (
        <Alert data-testid="card-verification-form-error" color="danger">
          {message}
        </Alert>
      )}
    </Box>
  );
}

export function CardVerificationCard({ entry = 'billing' }: { entry?: 'billing' | 'exhaustion' }) {
  const authenticated = useAccessToken(s => !!s.accessToken);
  const offer = useCardVerificationOffer(authenticated);
  const startVerification = useStartCardVerification();
  const completeVerification = useCompleteCardVerification();
  const removeVerification = useRemoveCardVerification();
  const refresh = useRefreshCardVerification();
  const titleId = useId();
  const [saveCard, setSaveCard] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [session, setSession] = useState<{
    verificationId: string;
    clientSecret: string;
    stripe: Promise<Stripe | null>;
  } | null>(null);
  const complete = async (verificationId: string) => {
    try {
      const data = await completeVerification.mutateAsync(verificationId);
      if (data.outcome === 'granted' || data.outcome === 'already_granted') {
        setMessage('Card verified, not charged. Your promotional credits are available.');
        setSession(null);
        return;
      }
      if (data.outcome !== 'pending') {
        setMessage('This card has already unlocked credits or did not qualify.');
        setSession(null);
        return;
      }
      const { clientSecret, publishableKey } = data;
      if (!clientSecret || !publishableKey) {
        // Stripe is still processing, or the webhook is finishing it; the form can no longer be submitted.
        setMessage('Verification is processing. Your credits will appear once it finishes.');
        setSession(null);
        return;
      }
      if (session) setMessage('Your card is not verified yet. Check the details and try again.');
      setSession(current => current ?? { verificationId, clientSecret, stripe: loadStripe(publishableKey) });
    } finally {
      await refresh();
    }
  };
  if (!offer.data || (!message && !offer.data.available && !offer.data.saved.length && !offer.data.pending.length))
    return null;
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await operation();
    } catch (error) {
      if (error instanceof TurnstileCancelledError) return;
      setFailed(true);
      setMessage(getCardVerificationErrorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Box data-testid="card-verification-card" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {offer.data.available && (
        <>
          <Typography level="title-md">Unlock {offer.data.credits.toLocaleString()} more credits</Typography>
          <Typography level="body-sm">
            Verify a credit or debit card. You will not be charged. No subscription, no automatic renewal. Secured by
            Stripe.
          </Typography>
          <Typography level="body-xs">Prepaid cards and digital wallets are not supported for this offer.</Typography>
          <Checkbox
            data-testid="card-verification-save-checkbox"
            label="Save my card (optional)"
            checked={saveCard}
            disabled={busy || !!session}
            onChange={event => setSaveCard(event.target.checked)}
          />
          <Typography level="body-xs">
            Unless you choose to save it, your card is removed after verification.
          </Typography>
          <Button
            data-testid="card-verification-start-btn"
            loading={busy}
            disabled={!!session}
            onClick={() =>
              void run(async () => {
                if (!offer.data?.siteKey) throw new Error('Verification unavailable');
                const turnstileToken = await getTurnstileToken(offer.data.siteKey, 'card_verification');
                const data = await startVerification.mutateAsync({ turnstileToken, saveCard, entry });
                setSession({ ...data, stripe: loadStripe(data.publishableKey) });
              })
            }
          >
            Verify card - no charge
          </Button>
        </>
      )}
      {offer.data.saved.map(id => (
        <Button
          key={id}
          variant="outlined"
          data-testid="card-verification-remove-btn"
          loading={busy}
          onClick={() =>
            void run(async () => {
              await removeVerification.mutateAsync(id);
              await refresh();
              setMessage('Your saved verification card was removed.');
            })
          }
        >
          Remove saved card
        </Button>
      ))}
      {offer.data.pending.map(id => (
        <Button
          key={id}
          data-testid="card-verification-retry-btn"
          loading={busy}
          onClick={() => void run(() => complete(id))}
        >
          Finish card verification
        </Button>
      ))}
      {message && (
        <Alert data-testid="card-verification-result" color={failed ? 'danger' : 'success'}>
          {message}
        </Alert>
      )}
      <Modal open={!!session} onClose={() => setSession(null)}>
        <ModalDialog aria-labelledby={titleId} sx={{ width: 'min(95vw, 520px)' }}>
          <ModalClose />
          <Typography id={titleId} level="h4">
            Verify your card
          </Typography>
          <Typography level="body-sm">Secured by Stripe. No charge and nothing auto-renews.</Typography>
          {session && (
            <Elements stripe={session.stripe} options={{ clientSecret: session.clientSecret }}>
              <VerificationForm verificationId={session.verificationId} complete={complete} />
            </Elements>
          )}
        </ModalDialog>
      </Modal>
    </Box>
  );
}

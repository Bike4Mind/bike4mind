import { useCallback, useEffect, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import CircularProgress from '@mui/joy/CircularProgress';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AuthState } from '@shared/auth';
import type { AccountBilling } from '@shared/account';

type CheckoutState = 'idle' | 'opening' | 'pending';
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

function periodLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

export function BillingSettings({ auth }: { auth: AuthState | null }) {
  if (!auth || auth.status === 'initializing') {
    return <Typography data-testid="billing-auth-loading">Checking your saved sign-in...</Typography>;
  }
  if (auth.status !== 'signed-in') {
    return (
      <Stack spacing={1} data-testid="billing-signed-out">
        <Typography level="title-lg">Sign in to choose a plan</Typography>
        <Typography level="body-sm" textColor="text.tertiary">
          Personal subscriptions belong to your B4M account. Sign in from the account menu to continue.
        </Typography>
      </Stack>
    );
  }
  return <SignedInBilling key={`${auth.environment.url}:${auth.user?.id}`} />;
}

function SignedInBilling() {
  const [billing, setBilling] = useState<AccountBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState>('idle');
  const checkoutLock = useRef(false);
  const reading = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    setLoading(true);
    try {
      const next = await window.b4m.account.getBilling();
      if (!mounted.current) return;
      setBilling(next);
      setReadError(next.error ?? null);
      if (next.subscriptions.some(subscription => !TERMINAL_STATUSES.has(subscription.status))) {
        setCheckout('idle');
        checkoutLock.current = false;
      }
    } catch {
      if (mounted.current) setReadError('Could not load billing. Please try again.');
    } finally {
      reading.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const subscribe = async (priceId: string) => {
    if (checkoutLock.current) return;
    checkoutLock.current = true;
    setCheckout('opening');
    setCheckoutError(null);
    try {
      const result = await window.b4m.account.subscribePlan(priceId);
      if (!mounted.current || !checkoutLock.current) return;
      if (result.ok) setCheckout('pending');
      else {
        checkoutLock.current = false;
        setCheckout('idle');
        setCheckoutError(result.error);
      }
    } catch {
      if (!mounted.current || !checkoutLock.current) return;
      checkoutLock.current = false;
      setCheckout('idle');
      setCheckoutError('Could not open checkout. Please try again.');
    }
  };

  const subscriptions =
    billing?.subscriptions.filter(subscription => !TERMINAL_STATUSES.has(subscription.status)) ?? [];
  const hasSubscription = subscriptions.length > 0;

  return (
    <Stack spacing={2} data-testid="billing-settings">
      <Stack direction="row" alignItems="center" spacing={1}>
        <Stack sx={{ flex: 1 }}>
          <Typography level="title-lg">Billing</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Personal plans for your B4M account. Payment opens securely in your browser.
          </Typography>
        </Stack>
        <Button
          size="sm"
          variant="soft"
          color="neutral"
          loading={loading}
          onClick={() => void refresh()}
          data-testid="billing-refresh-btn"
        >
          Refresh
        </Button>
      </Stack>

      {loading && !billing && (
        <Stack direction="row" spacing={1} alignItems="center" data-testid="billing-loading">
          <CircularProgress size="sm" />
          <Typography level="body-sm">Loading plans and your subscription...</Typography>
        </Stack>
      )}
      {readError && (
        <Alert color="warning" data-testid="billing-read-error">
          {readError}
        </Alert>
      )}
      {checkoutError && (
        <Alert color="danger" data-testid="billing-checkout-error">
          {checkoutError}
        </Alert>
      )}

      {checkout !== 'idle' && (
        <Alert color="primary" data-testid="billing-checkout-pending">
          <Stack spacing={1}>
            <Typography level="body-sm">
              {checkout === 'opening'
                ? 'Opening checkout in your browser...'
                : 'Checkout opened in your browser. Finish payment there, then return here. Your plan is not confirmed until billing refreshes.'}
            </Typography>
            {checkout === 'pending' && (
              <Button
                size="sm"
                variant="plain"
                disabled={loading}
                data-testid="billing-checkout-canceled-btn"
                onClick={() => {
                  checkoutLock.current = false;
                  setCheckout('idle');
                  void refresh();
                }}
              >
                I canceled or closed checkout
              </Button>
            )}
          </Stack>
        </Alert>
      )}

      {billing && !readError && (
        <>
          <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid="billing-current-plan">
            <Typography level="body-xs" textColor="text.tertiary">
              Current subscription
            </Typography>
            {!hasSubscription ? (
              <Typography level="title-md">Free</Typography>
            ) : (
              subscriptions.map(subscription => {
                const plan = billing.plans.find(plan => plan.priceId === subscription.priceId);
                const period = periodLabel(subscription.periodEndsAt);
                const paymentIssue = subscription.status === 'past_due' || subscription.status === 'unpaid';
                return (
                  <Stack key={subscription.subscriptionId ?? subscription.priceId} spacing={0.5}>
                    <Typography level="title-md">{plan?.name ?? 'Subscribed'}</Typography>
                    <Typography level="body-sm" textColor={paymentIssue ? 'danger.plainColor' : 'text.secondary'}>
                      {subscription.status.replaceAll('_', ' ')}
                      {plan ? `, billed ${plan.interval}` : ''}
                      {period
                        ? ` - ${subscription.canceledAt ? 'ends' : paymentIssue ? 'billing period ends' : 'current period ends'} ${period}`
                        : ''}
                    </Typography>
                    {paymentIssue && (
                      <Typography level="body-sm" color="danger">
                        Payment needs attention. Manage your subscription in the B4M web app.
                      </Typography>
                    )}
                  </Stack>
                );
              })
            )}
            {hasSubscription && (
              <Typography level="body-sm" sx={{ mt: 1 }} textColor="text.tertiary">
                To change or cancel your existing subscription, use Billing in the B4M web app.
              </Typography>
            )}
          </Sheet>

          {!billing.billingEnabled ? (
            <Typography data-testid="billing-unavailable">
              Personal subscriptions are not available on this server.
            </Typography>
          ) : billing.plans.length === 0 ? (
            <Typography data-testid="billing-no-plans">
              No personal plans are available right now. Try refreshing later.
            </Typography>
          ) : (
            billing.plans.map(plan => {
              const current = subscriptions.some(subscription => subscription.priceId === plan.priceId);
              const price =
                plan.priceCents === null
                  ? null
                  : new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency }).format(
                      plan.priceCents / 100
                    );
              return (
                <Sheet
                  key={plan.priceId}
                  variant="outlined"
                  sx={{ p: 2, borderRadius: 'sm' }}
                  data-testid="billing-plan-card"
                >
                  <Stack spacing={1.5}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography level="title-lg">{plan.name}</Typography>
                      {current && (
                        <Chip size="sm" data-testid="billing-plan-current">
                          Current
                        </Chip>
                      )}
                    </Stack>
                    <Typography level="body-sm" textColor="text.secondary">
                      {plan.description}
                    </Typography>
                    <Typography level="h3">
                      {price ?? 'Price unavailable'}
                      {price ? ` / ${plan.interval === 'monthly' ? 'month' : 'year'}` : ''}
                    </Typography>
                    <Typography level="body-sm">{plan.credits.toLocaleString()} credits per month</Typography>
                    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                      {plan.features.map(feature => (
                        <Typography component="li" level="body-sm" key={feature}>
                          {feature}
                        </Typography>
                      ))}
                    </Box>
                    <Button
                      data-testid="billing-subscribe-btn"
                      aria-label={`Subscribe to ${plan.name}, billed ${plan.interval}`}
                      disabled={loading || hasSubscription || plan.priceCents === null || checkout !== 'idle'}
                      onClick={() => void subscribe(plan.priceId)}
                    >
                      {current
                        ? 'Current plan'
                        : hasSubscription
                          ? 'Manage in web app'
                          : checkout !== 'idle'
                            ? 'Checkout in progress'
                            : `Subscribe to ${plan.name}`}
                    </Button>
                  </Stack>
                </Sheet>
              );
            })
          )}
        </>
      )}
    </Stack>
  );
}

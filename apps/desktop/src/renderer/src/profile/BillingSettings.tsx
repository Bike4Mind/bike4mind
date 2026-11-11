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
import { CheckIcon } from '../chat/icons';

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
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState>('idle');
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseNotice, setPurchaseNotice] = useState<string | null>(null);
  const purchaseLock = useRef(false);
  const checkoutLock = useRef(false);
  const reading = useRef(false);
  const refreshQueued = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) {
      refreshQueued.current = true;
      return;
    }
    reading.current = true;
    setLoading(true);
    try {
      const next = await window.b4m.account.getBilling();
      if (!mounted.current) return;
      setBilling(next);
      setBalance(next.balance ?? null);
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
      if (refreshQueued.current && mounted.current) {
        refreshQueued.current = false;
        void refresh();
      }
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
  const selectedPack =
    billing?.creditPackages?.find(pack => pack.id === selectedPackId) ?? billing?.creditPackages?.[0];
  const purchase = async () => {
    if (purchaseLock.current || !selectedPack) return;
    purchaseLock.current = true;
    setPurchasing(true);
    setCheckoutError(null);
    setPurchaseNotice(null);
    try {
      const result = await window.b4m.account.purchaseCredits(selectedPack.id);
      if (!mounted.current) return;
      if (!result.ok) setCheckoutError(result.error);
      else
        setPurchaseNotice(
          'Payment window closed. Your balance is refreshed from the server; completed payments may take a moment to appear.'
        );
      await refresh();
    } catch {
      if (mounted.current)
        setCheckoutError('Could not open credit checkout. Refresh your balance before trying again.');
    } finally {
      purchaseLock.current = false;
      if (mounted.current) setPurchasing(false);
    }
  };

  return (
    <Stack spacing={3} data-testid="billing-settings" sx={{ maxWidth: 880, mx: 'auto', width: '100%' }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Stack sx={{ flex: 1 }}>
          <Typography level="title-lg">Billing</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Your credits, plan, and billing details.
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
      {purchaseNotice && <Alert data-testid="billing-purchase-notice">{purchaseNotice}</Alert>}

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
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
              gap: 4,
              pb: 3,
              borderBottom: '1px solid',
              borderColor: 'divider',
            }}
          >
            <Box data-testid="billing-balance">
              <Typography
                level="body-xs"
                sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, color: 'text.tertiary' }}
              >
                Balance
              </Typography>
              <Typography
                sx={{
                  mt: 0.5,
                  fontSize: '2.25rem',
                  fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  lineHeight: 1.2,
                }}
              >
                {balance === null ? 'Unavailable' : balance.toLocaleString()}
              </Typography>
              <Typography level="body-sm" textColor="text.tertiary">
                {balance === null ? 'Could not read your credit balance.' : 'credits available'}
              </Typography>
            </Box>
            <Box data-testid="billing-current-plan">
              <Typography
                level="body-xs"
                sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, color: 'text.tertiary' }}
              >
                Plan
              </Typography>
              {!hasSubscription ? (
                <Typography level="title-lg" sx={{ mt: 0.5, fontWeight: 600 }}>
                  Free
                </Typography>
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
            </Box>
          </Box>

          <Box>
            <Typography level="title-lg" sx={{ fontWeight: 600 }}>
              {hasSubscription ? 'Your plan' : 'Upgrade'}
            </Typography>
            <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.25 }}>
              Get a monthly credit allowance instead of topping up by hand.
            </Typography>
          </Box>
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" spacing={1.5}>
            <Chip variant="soft">Personal</Chip>
            <Typography level="body-xs" textColor="text.tertiary" sx={{ alignSelf: { sm: 'center' } }}>
              Credits roll over for 3 months. Secure checkout in your browser.
            </Typography>
          </Stack>

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
                  sx={{
                    p: { xs: 2.5, sm: 3 },
                    borderRadius: 'lg',
                    bgcolor: 'background.surface',
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1.15fr) minmax(0, 1fr)' },
                    gap: { xs: 2.5, sm: 4 },
                    ...(!current && {
                      borderColor: 'primary.500',
                      boxShadow: '0 0 0 1px var(--joy-palette-primary-500)',
                    }),
                  }}
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
                    <Typography
                      level="h3"
                      sx={{
                        pt: 1,
                        fontSize: '2.5rem',
                        fontWeight: 600,
                        letterSpacing: '-0.02em',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {price ?? 'Price unavailable'}
                      <Typography level="body-sm" textColor="text.tertiary">
                        {price ? ` / ${plan.interval === 'monthly' ? 'month' : 'year'}` : ''}
                      </Typography>
                    </Typography>
                    <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                      {plan.credits.toLocaleString()} credits per month
                    </Typography>
                    <Button
                      data-testid="billing-subscribe-btn"
                      aria-label={`Subscribe to ${plan.name}, billed ${plan.interval}`}
                      disabled={
                        loading || purchasing || hasSubscription || plan.priceCents === null || checkout !== 'idle'
                      }
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
                  <Box
                    sx={{
                      pt: { xs: 2.5, sm: 0 },
                      pl: { xs: 0, sm: 4 },
                      borderStyle: 'solid',
                      borderColor: 'neutral.outlinedBorder',
                      borderWidth: { xs: '1px 0 0 0', sm: '0 0 0 1px' },
                    }}
                  >
                    <Typography
                      level="body-xs"
                      sx={{
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                        fontWeight: 600,
                        color: 'text.tertiary',
                        mb: 1.5,
                      }}
                    >
                      Includes
                    </Typography>
                    <Box
                      component="ul"
                      sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}
                    >
                      {plan.features.map(feature => (
                        <Box component="li" key={feature} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                          <Box sx={{ color: 'primary.plainColor', flexShrink: 0 }}>
                            <CheckIcon />
                          </Box>
                          <Typography level="body-sm">{feature}</Typography>
                        </Box>
                      ))}
                    </Box>
                  </Box>
                </Sheet>
              );
            })
          )}
          <Stack
            spacing={2}
            sx={{ pt: 3, borderTop: '1px solid', borderColor: 'divider' }}
            data-testid="billing-top-up"
          >
            <Box>
              <Typography level="title-lg">Top up credits</Typography>
              <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                {hasSubscription
                  ? 'One-time packs, added on top of your monthly allowance.'
                  : 'One-time packs, added to your balance. No subscription needed.'}
              </Typography>
            </Box>
            {billing.creditPackages?.length ? (
              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}
              >
                {billing.creditPackages.map(pack => (
                  <Sheet
                    variant="outlined"
                    key={pack.id}
                    data-testid={`billing-credit-pack-${pack.id}`}
                    sx={{ p: 2.5, borderRadius: 'lg', bgcolor: 'background.surface' }}
                  >
                    <Button
                      variant={selectedPack?.id === pack.id ? 'soft' : 'plain'}
                      color="neutral"
                      data-testid={`billing-select-${pack.id}`}
                      aria-pressed={selectedPack?.id === pack.id}
                      disabled={purchasing}
                      onClick={() => setSelectedPackId(pack.id)}
                      sx={{ mb: 1 }}
                    >
                      {selectedPack?.id === pack.id ? 'Selected' : 'Select pack'}
                    </Button>
                    <Typography sx={{ fontSize: '1.75rem', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                      {pack.credits.toLocaleString()}
                    </Typography>
                    <Typography level="body-sm" textColor="text.tertiary">
                      credits
                    </Typography>
                    <Typography level="title-lg" sx={{ mt: 2 }}>
                      ${pack.price.toLocaleString()}
                    </Typography>
                    <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 0.5 }}>
                      {pack.description}
                    </Typography>
                  </Sheet>
                ))}
              </Box>
            ) : (
              <Typography level="body-sm" textColor="text.tertiary">
                Credit packs are unavailable. Refresh to try again.
              </Typography>
            )}
            <Typography level="body-xs" textColor="text.tertiary">
              Secure payment opens inside the desktop app. Purchases are added to your personal balance.
            </Typography>
            <Button
              data-testid="billing-top-up-btn"
              loading={purchasing}
              disabled={!billing.billingEnabled || !selectedPack || loading || checkout !== 'idle'}
              onClick={() => void purchase()}
              sx={{ alignSelf: { sm: 'flex-end' } }}
            >
              {selectedPack
                ? `Buy ${selectedPack.credits.toLocaleString()} credits for $${selectedPack.price.toLocaleString()}`
                : 'Buy credits'}
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}

import { useUser } from '@client/app/contexts/UserContext';
import { useGetSettingsValue, useSettingsFromServer } from '@client/app/hooks/data/settings';
import { useSubscribePlan } from '@client/app/hooks/data/subscriptions';
import { billingLandingHref } from '@client/app/utils/billingDeepLink';
import { allowedCheckoutReturn, checkoutCallbackUrl } from '@client/app/utils/checkoutReturn';
import { getErrorMessage } from '@client/app/utils/error';
import { ExternalLinks } from '@client/app/utils/externalLinks';
import { PROFESSIONAL_PRICE_ID, SUBSCRIPTION_PLANS_MAP } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { Button, Card, LinearProgress, Stack, Typography } from '@mui/joy';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { useEffect } from 'react';

/** Plan names a link may use instead of a Stripe price id, so an app outside this repo never carries one. */
export const CHECKOUT_PLAN_ALIASES: Readonly<Record<string, () => string>> = {
  professional: () => PROFESSIONAL_PRICE_ID,
};

/** Returns the price id `plan` names: an alias resolved, anything else as given. */
export function resolveCheckoutPlan(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const alias = Object.prototype.hasOwnProperty.call(CHECKOUT_PLAN_ALIASES, plan) ? CHECKOUT_PLAN_ALIASES[plan] : null;
  return alias ? alias() || undefined : plan;
}

type CheckoutProblem = 'unavailable' | 'invalid-plan' | 'failed';

const PROBLEM_COPY: Record<CheckoutProblem, { title: string; body: string }> = {
  unavailable: {
    title: 'Subscriptions are not available here',
    body: 'This workspace does not sell plans, so there is nothing to check out.',
  },
  'invalid-plan': {
    title: 'We could not find that plan',
    body: 'The link you followed points to a plan that does not exist or is no longer offered.',
  },
  failed: {
    title: 'We could not start your checkout',
    body: 'Nothing was charged. You can pick a plan again or contact support.',
  },
};

const CheckoutProblemCard = ({ problem, detail }: { problem: CheckoutProblem; detail?: string }) => {
  const router = useRouter();
  const navigate = useNavigate();
  const copy = PROBLEM_COPY[problem];

  return (
    <Stack alignItems="center" justifyContent="center" sx={{ minHeight: '60vh', p: 2 }}>
      <Card data-testid="checkout-error-card" variant="outlined" sx={{ maxWidth: 480, width: '100%', gap: 1.5 }}>
        <Typography level="title-lg" component="h1">
          {copy.title}
        </Typography>
        <Typography level="body-md">{copy.body}</Typography>
        {detail && (
          <Typography data-testid="checkout-error-detail" level="body-sm" sx={{ color: 'text.tertiary' }}>
            {detail}
          </Typography>
        )}
        <Stack direction="row" spacing={1} sx={{ pt: 1, flexWrap: 'wrap' }}>
          {problem === 'unavailable' ? (
            <Button data-testid="checkout-error-home-btn" onClick={() => navigate({ to: '/' })}>
              Back to the app
            </Button>
          ) : (
            <Button
              data-testid="checkout-error-plans-btn"
              onClick={() => router.history.push(billingLandingHref('plans'))}
            >
              See plans
            </Button>
          )}
          <Button
            data-testid="checkout-error-support-btn"
            variant="outlined"
            color="neutral"
            component="a"
            href={ExternalLinks.support}
            target="_blank"
            rel="noopener noreferrer"
          >
            Contact support
          </Button>
        </Stack>
      </Card>
    </Stack>
  );
};

/**
 * Redirects to the Stripe checkout page for the selected subscription plan, or explains why it
 * cannot (billing off, unknown plan, checkout refused) with a way forward.
 * If the user is not logged in, redirects to register with the plan ID as a query param.
 */
const SubscriptionsCheckoutPage = () => {
  const { currentUser } = useUser();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { plan?: string; return_to?: string };
  const plan = resolveCheckoutPlan(search.plan);
  // Another Bike4Mind app's page to come back to (utils/checkoutReturn.ts); null unless allowed.
  const returnTo = allowedCheckoutReturn(search.return_to);
  const subscribe = useSubscribePlan();
  const settings = useSettingsFromServer();
  const enforceCredits = useGetSettingsValue('enforceCredits');

  // Mirrors the server's configured-plan check in pages/api/subscriptions/subscribe.ts, so a
  // stale or mistyped link fails here instead of after a round trip.
  const problem: CheckoutProblem | undefined = settings.isPending
    ? undefined
    : !enforceCredits
      ? 'unavailable'
      : !plan || !SUBSCRIPTION_PLANS_MAP[plan]
        ? 'invalid-plan'
        : subscribe.isError
          ? 'failed'
          : undefined;

  useEffect(() => {
    if (problem || subscribe.isPending || settings.isPending || subscribe.isSuccess || subscribe.isError) {
      return;
    }

    if (!currentUser) {
      if (!returnTo) {
        navigate({ to: `/register?redirectTo=/subscriptions/checkout?plan=${plan}` });
        return;
      }
      // Encoded, so the return target survives the sign-up as part of the one redirectTo value.
      const resume = `/subscriptions/checkout?${new URLSearchParams({ plan: search.plan ?? '', return_to: returnTo })}`;
      navigate({ to: `/register?redirectTo=${encodeURIComponent(resume)}` });
      return;
    }

    subscribe.mutate(
      {
        priceId: plan as string,
        callbackUrl: checkoutCallbackUrl(window.location.origin, returnTo),
      },
      {
        onSuccess: data => {
          window.location.href = data.sessionUrl;
        },
      }
    );
  }, [problem, currentUser, navigate, subscribe, settings, plan, returnTo, search.plan]);

  if (problem) {
    return (
      <CheckoutProblemCard
        problem={problem}
        detail={problem === 'failed' ? getErrorMessage(subscribe.error) : undefined}
      />
    );
  }

  return <LinearProgress />;
};

export default SubscriptionsCheckoutPage;

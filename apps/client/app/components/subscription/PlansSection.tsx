import { useCreateTeamModal } from '@client/app/components/organizations/CreateTeamModal';
import { useConfig } from '@client/app/hooks/data/settings';
import { useSignupGrantCredits } from '@client/app/hooks/useSignupGrantCredits';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { useTeamPlanAvailable } from '@client/app/hooks/data/teamPlanSettings';
import {
  isCancellableSubscriptionStatus,
  isDelinquentSubscriptionStatus,
  pickSubscriptionByPrice,
  resolveSubscriptionSource,
  SubscriptionSource,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  ORGANIZATION_SUBSCRIPTION_PRICE_ID,
  TEAM_PLAN_UNAVAILABLE_MESSAGE,
} from '@bike4mind/server-utils/lib/subscriptions/constants';
import { professionalPriceIdForStage, SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanDetail } from '@client/lib/userSubscriptions/types';
import { Box, Button, Skeleton, Stack, Tab, tabClasses, TabList, Tabs, Tooltip, Typography } from '@mui/joy';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SubscribeButton from '../Credits/SubscribeButton';
import ManageSubscriptionButton from './ManageSubscriptionButton';
import PlanCard from './PlanCard';
import { isPopularPlan } from './isPopularPlan';
import { useTeamCreditsPerSeat, useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { useSelectedModelAnswerCost } from '@client/app/hooks/useSelectedModelAnswerCost';
import { formatAnswersEstimate } from '@client/app/utils/creditEstimate';

// Bullets, credits and copy come from the shared plan table so this section and the server-side plan
// map cannot drift; only the price id is re-picked by runtime stage below.
const PROFESSIONAL_PLAN = SUBSCRIPTION_PLANS.find(plan => plan.name === 'Professional');
if (!PROFESSIONAL_PLAN) {
  throw new Error("PlansSection: no 'Professional' entry in SUBSCRIPTION_PLANS (userSubscriptions/constants)");
}

function centsToDollars(cents: number | undefined) {
  if (cents === undefined) return 0;
  return cents / 100;
}

enum PlanAudience {
  Personal = 'personal',
  Business = 'business',
}

/** Card-sized placeholder so the section keeps its height while plans and subscriptions load. */
export const PlansSectionSkeleton = () => (
  <Box data-testid="plans-section-skeleton" aria-hidden>
    <Skeleton variant="rectangular" sx={{ width: 200, height: 36, borderRadius: 'md', mb: 2 }} />
    <Skeleton variant="rectangular" sx={{ borderRadius: 'lg', height: { xs: 520, sm: 300 } }} />
  </Box>
);

/** Plan cards for the Billing modal: Professional for individuals, Team for businesses. */
export const PlansSection = ({ onSubscriptionChanged }: { onSubscriptionChanged?: () => void }) => {
  const { t } = useTranslation();
  const [audience, setAudience] = useState<PlanAudience>(PlanAudience.Personal);
  // The starter-credits line is only true while sign-ups are actually granted something.
  const hasStarterCredits = useSignupGrantCredits() > 0;
  const { data: config } = useConfig();
  const seedStageName = config?.seedStageName || process.env.NEXT_PUBLIC_SEED_STAGE_NAME || '';
  const isTestMode = seedStageName !== 'production';

  const subscriptions = useGetSubscriptions({ enabled: true });
  const plans = useGetSubscriptionPlans();
  const activePlans = useMemo(() => (plans.data ?? []).filter(plan => plan.active), [plans.data]);
  // Non-terminal, not just active: a past_due subscription is still the user's
  // current plan, and its card has to offer Cancel rather than a second checkout.
  const cancellableSubscriptions = useMemo(
    () => (subscriptions.data ?? []).filter(sub => isCancellableSubscriptionStatus(sub.status)),
    [subscriptions.data]
  );
  const openCreateTeamModal = useCreateTeamModal(state => state.open);
  const teamPlanAvailable = useTeamPlanAvailable();
  const teamTabReasonId = useId();
  // Drop a Business selection when the gate closes (render-phase adjust-on-change, per React's pattern):
  // React re-runs this render, so no Team card commits and a later flip back on does not jump to Business.
  if (!teamPlanAvailable && audience === PlanAudience.Business) {
    setAudience(PlanAudience.Personal);
  }
  const priceMap = useMemo(() => {
    return plans.data?.reduce(
      (acc, plan) => {
        if (!plan.unit_amount) return acc;
        acc[plan.id] = plan.unit_amount;
        return acc;
      },
      {} as Record<string, number>
    );
  }, [plans.data]);

  // The card quotes the cheapest Team checkout (minimum seats at the live Stripe per-seat price), the
  // same figure CreateTeamModal opens on. Undefined hides the price rather than inventing one.
  const { minSeats: teamMinSeats } = useTeamSeatLimits();
  const teamCreditsPerSeat = useTeamCreditsPerSeat();
  const teamSeatPrice = priceMap?.[ORGANIZATION_SUBSCRIPTION_PRICE_ID];
  // Multiplied in integer cents, then converted once, so a whole-dollar total stays an integer ("$70").
  const teamPlanMinimumPrice = teamSeatPrice === undefined ? undefined : (teamSeatPrice * teamMinSeats) / 100;
  const teamPlanCredits = teamMinSeats * teamCreditsPerSeat;
  const answerCost = useSelectedModelAnswerCost();

  const subscriptionPlans: SubscriptionPlanDetail[] = useMemo(
    () => [
      {
        ...PROFESSIONAL_PLAN,
        // Selected by runtime stage here to match the rest of this section.
        priceId: professionalPriceIdForStage(isTestMode),
      },
    ],
    [isTestMode]
  );

  const availablePlans = useMemo(
    () =>
      audience === PlanAudience.Personal
        ? subscriptionPlans.filter(plan => activePlans.find(p => p.id === plan.priceId))
        : [],
    [activePlans, audience, subscriptionPlans]
  );

  if (subscriptions.isPending || plans.isPending) {
    return <PlansSectionSkeleton />;
  }

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 1.5,
          mb: 2,
        }}
      >
        <Tabs
          value={audience}
          onChange={(_, value) => setAudience(value as PlanAudience)}
          sx={{ bgcolor: 'transparent' }}
          aria-label={t('subscription_modal.audience_label', 'Plan type')}
        >
          <TabList
            disableUnderline
            size="sm"
            sx={{
              p: 0.5,
              gap: 0.5,
              borderRadius: 'md',
              bgcolor: 'background.level1',
              [`& .${tabClasses.root}`]: {
                borderRadius: 'sm',
                fontWeight: 500,
                color: 'text.secondary',
                '&:hover': { bgcolor: 'background.level2' },
              },
              [`& .${tabClasses.root}[aria-selected="true"]`]: {
                bgcolor: 'background.surface',
                color: 'text.primary',
                boxShadow: 'sm',
              },
            }}
          >
            <Tab disableIndicator value={PlanAudience.Personal} data-testid="subscription-modal-personal-tab">
              {t('subscription_modal.personal')}
            </Tab>

            {/* Off, the tab stays visible but disabled. Joy keeps a disabled tab focusable, so the reason hangs
                off the Tab via aria-describedby; the span only exists to receive hover (the disabled tab
                has pointer-events: none) and is deliberately not focusable. The reason stays outside the Tab:
                a descendant would join its accessible name. */}
            <Tooltip title={teamPlanAvailable ? undefined : TEAM_PLAN_UNAVAILABLE_MESSAGE} placement="bottom">
              <span style={{ display: 'inline-flex' }} data-testid="subscription-modal-business-tab-wrapper">
                <Tab
                  disableIndicator
                  value={PlanAudience.Business}
                  disabled={!teamPlanAvailable}
                  aria-describedby={teamPlanAvailable ? undefined : teamTabReasonId}
                  data-testid="subscription-modal-business-tab"
                >
                  {t('subscription_modal.business')}
                </Tab>
              </span>
            </Tooltip>
          </TabList>
          {/* aria-describedby resolves the id document-wide, so the reason stays a sibling of the tablist:
              inside it, browse mode would read the text as stray content beside the tabs. */}
          {!teamPlanAvailable && (
            <Box component="span" id={teamTabReasonId} sx={visuallyHidden}>
              {TEAM_PLAN_UNAVAILABLE_MESSAGE}
            </Box>
          )}
        </Tabs>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', maxWidth: 360, textAlign: { sm: 'right' } }}>
          {hasStarterCredits && (
            <>
              <Box component="span" data-testid="subscription-modal-starter-credits">
                {t('subscription_modal.starter_credits')}
              </Box>{' '}
            </>
          )}
          {t('subscription_modal.credits_rollover')}
        </Typography>
      </Box>

      {audience === PlanAudience.Personal && (
        <Stack gap={2}>
          {availablePlans.map(plan => {
            // Active-first per price: a stale delinquent row at this price must not
            // mark the plan the user is actually paying for as payment-failed.
            const isCurrentPlan = pickSubscriptionByPrice(cancellableSubscriptions, plan.priceId);
            const hasPaymentIssue = !!isCurrentPlan && isDelinquentSubscriptionStatus(isCurrentPlan.status);
            // The portal route refuses admin-granted plans, so only Stripe-managed rows get Manage.
            const isStripeManaged =
              !!isCurrentPlan && resolveSubscriptionSource(isCurrentPlan) === SubscriptionSource.Stripe;
            return (
              <PlanCard
                key={plan.priceId}
                name={plan.name}
                credits={plan.credits}
                answersEstimate={formatAnswersEstimate(plan.credits, answerCost)}
                description={plan.description}
                price={centsToDollars(priceMap?.[plan.priceId])}
                interval={plan.interval}
                features={plan.features}
                isPopular={isPopularPlan(plan.name, availablePlans.length)}
                isFeatured={!isCurrentPlan}
                isCurrentPlan={!!isCurrentPlan}
                hasPaymentIssue={hasPaymentIssue}
                currentPlanDetails={isCurrentPlan}
                priceId={plan.priceId}
                actionButton={
                  <Stack gap={1} direction={{ xs: 'column', sm: 'row' }} sx={{ '& > *': { flex: 1 } }}>
                    {isStripeManaged && <ManageSubscriptionButton isPrimaryAction={hasPaymentIssue} />}
                    <SubscribeButton
                      priceId={plan.priceId}
                      planName={plan.name}
                      onSubscriptionChanged={onSubscriptionChanged}
                      cancellableSubscriptions={cancellableSubscriptions}
                    />
                  </Stack>
                }
              />
            );
          })}
        </Stack>
      )}

      {audience === PlanAudience.Business && (
        <PlanCard
          name={t('subscription_modal.team')}
          description="Collaborative AI workspace with shared resources and advanced project management."
          price={teamPlanMinimumPrice}
          credits={teamPlanCredits}
          answersEstimate={formatAnswersEstimate(teamPlanCredits, answerCost)}
          interval="month"
          isFeatured
          features={[
            // One flat price covers up to teamMinSeats people, so a pair or trio pays the same: don't present the floor
            // as a headcount to fill.
            teamSeatPrice === undefined
              ? `Up to ${teamMinSeats} people at one flat price`
              : `Up to ${teamMinSeats} people at one flat price; $${centsToDollars(teamSeatPrice).toFixed(2)} per month for each person after that`,
            'Shared credit pool with 3-month rollover',
            'Advanced Projects with RAG & Auto-Summary',
            'Team workspace & knowledge management',
            'Automated tagging & organization',
            'Usage analytics across all models',
            'Advanced security controls',
            'Priority support in a dedicated channel',
          ]}
          actionButton={
            <Stack gap={1}>
              {/* Same checkout as Teams > Create Team: the modal picks the seats and opens Stripe. */}
              <Button
                variant="solid"
                color="primary"
                fullWidth
                disabled={teamSeatPrice === undefined}
                onClick={openCreateTeamModal}
                data-testid="subscription-modal-create-team-btn"
              >
                Create Team
              </Button>
              {teamSeatPrice === undefined && (
                <Typography level="body-sm" color="danger" data-testid="subscription-modal-team-unavailable">
                  Team pricing is unavailable right now. Please try again later.
                </Typography>
              )}
            </Stack>
          }
        />
      )}
    </Box>
  );
};

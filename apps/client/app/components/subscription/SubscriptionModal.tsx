import { useCreateTeamModal } from '@client/app/components/organizations/CreateTeamModal';
import { useGetSettingsValue, useConfig } from '@client/app/hooks/data/settings';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { useTeamPlanAvailable } from '@client/app/hooks/data/teamPlanSettings';
import {
  isCancellableSubscriptionStatus,
  isDelinquentSubscriptionStatus,
  pickSubscriptionByPrice,
  resolveSubscriptionSource,
  SubscriptionSource,
} from '@client/lib/subscriptions/types';
import { ORGANIZATION_SUBSCRIPTION_PRICE_ID, TEAM_PLAN_UNAVAILABLE_MESSAGE } from '@client/lib/subscriptions/constants';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { SubscriptionPlanDetail } from '@client/lib/userSubscriptions/types';
import {
  Box,
  Button,
  CircularProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Tab,
  tabClasses,
  TabList,
  Tabs,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/joy';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SubscribeButton from '../Credits/SubscribeButton';
import ManageSubscriptionButton from './ManageSubscriptionButton';
import PlanCard from './PlanCard';
import { isPopularPlan } from './isPopularPlan';
import { useTeamCreditsPerSeat, useTeamSeatLimits } from '@client/app/hooks/data/teamPlanSettings';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { useAnswerCostReference } from '@client/app/hooks/useAnswerCostReference';
import { formatAnswersEstimate } from '@client/app/utils/creditEstimate';

// Bullets, credits and copy come from the shared plan table so this modal and the server-side plan
// map cannot drift; only the price id is re-picked by runtime stage below.
const PROFESSIONAL_PLAN = SUBSCRIPTION_PLANS.find(plan => plan.name === 'Professional');
if (!PROFESSIONAL_PLAN) {
  throw new Error("SubscriptionModal: no 'Professional' entry in SUBSCRIPTION_PLANS (userSubscriptions/constants)");
}

function centsToDollars(cents: number | undefined) {
  if (cents === undefined) return 0;
  return cents / 100;
}

enum SubscriptionModalTabs {
  Personal = 'personal',
  Business = 'business',
}

interface SubscriptionModalProps {
  open: boolean;
  onClose: () => void;
}

const SubscriptionModal = ({ open, onClose }: SubscriptionModalProps) => {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        sx={{
          maxWidth: 1472,
          width: '90%',
          p: 3,
          overflow: 'auto',
        }}
      >
        <ModalClose />
        {open && <SubscriptionModalContent />}
      </ModalDialog>
    </Modal>
  );
};

const SubscriptionModalContent = () => {
  const { t } = useTranslation();
  const theme = useTheme();
  const [selectedTab, setSelectedTab] = useState<SubscriptionModalTabs>(SubscriptionModalTabs.Personal);
  // The starter-credits line is only true while sign-ups are actually granted something.
  const hasStarterCredits = Number(useGetSettingsValue('defaultFreeCredits')) > 0;
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
  if (!teamPlanAvailable && selectedTab === SubscriptionModalTabs.Business) {
    setSelectedTab(SubscriptionModalTabs.Personal);
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
  const teamPlanMinimumPrice = teamSeatPrice === undefined ? undefined : centsToDollars(teamSeatPrice) * teamMinSeats;
  const teamPlanCredits = teamMinSeats * teamCreditsPerSeat;
  const answerCostReference = useAnswerCostReference();

  // Build subscription plans based on runtime stage
  const subscriptionPlans: SubscriptionPlanDetail[] = useMemo(
    () => [
      {
        ...PROFESSIONAL_PLAN,
        // Account-tied Stripe price from NEXT_PUBLIC_* env vars (no brand fallback). Same env
        // contract as PROFESSIONAL_PRICE_ID in userSubscriptions/constants; selected by runtime
        // stage here to match the rest of this modal.
        priceId: isTestMode
          ? (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ?? '')
          : (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ?? ''),
      },
    ],
    [isTestMode]
  );

  const availablePlans = useMemo(
    () =>
      selectedTab === SubscriptionModalTabs.Personal
        ? subscriptionPlans.filter(plan => activePlans.find(p => p.id === plan.priceId))
        : [],
    [activePlans, selectedTab, subscriptionPlans]
  );

  if (subscriptions.isPending || plans.isPending) {
    return (
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100%',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  return (
    <>
      <Typography sx={{ mb: '8px', fontSize: '24px', lineHeight: '24px', textAlign: 'center' }}>
        {t('subscription_modal.title')}
      </Typography>
      <Typography sx={{ mb: '36px', fontSize: '16px', color: 'neutral.500', textAlign: 'center' }}>
        {t('subscription_modal.description')}
        <br />
        {hasStarterCredits && (
          <>
            <Box
              component="span"
              data-testid="subscription-modal-starter-credits"
              sx={{ color: theme.palette.subscriptionModal.linkColor, fontWeight: '500' }}
            >
              {t('subscription_modal.starter_credits')}
            </Box>{' '}
          </>
        )}
        {t('subscription_modal.credits_rollover')}
      </Typography>

      <Box sx={{ mb: '24px', display: 'flex', justifyContent: 'center' }}>
        <Tabs
          value={selectedTab}
          onChange={(_, value) => setSelectedTab(value as SubscriptionModalTabs)}
          sx={{
            bgcolor: 'transparent',
          }}
          aria-label="tabs"
        >
          <TabList
            disableUnderline
            sx={{
              p: 0.5,
              gap: 0.5,
              borderRadius: '10px',
              border: '1px solid',
              borderColor: theme.palette.subscriptionModal.tabsBorderColor,
              bgcolor: theme.palette.subscriptionModal.tabsBackgroundColor,
              [`& .${tabClasses.root}[aria-selected="true"]`]: {
                boxShadow: 'sm',
                bgcolor: 'primary.500',
                color: 'white',
              },
              [`& .${tabClasses.root}`]: {
                borderRadius: '6px',
              },
            }}
          >
            <Tab disableIndicator value={SubscriptionModalTabs.Personal}>
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
                  value={SubscriptionModalTabs.Business}
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
      </Box>

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          gap: '32px',
        }}
      >
        {selectedTab === SubscriptionModalTabs.Personal && (
          <>
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
                  answersEstimate={formatAnswersEstimate(plan.credits, answerCostReference)}
                  description={plan.description}
                  price={centsToDollars(priceMap?.[plan.priceId])}
                  interval={plan.interval}
                  features={plan.features}
                  isPopular={isPopularPlan(plan.name, availablePlans.length)}
                  isCurrentPlan={!!isCurrentPlan}
                  hasPaymentIssue={hasPaymentIssue}
                  currentPlanDetails={isCurrentPlan}
                  priceId={plan.priceId}
                  actionButton={
                    <Stack gap={1}>
                      {isStripeManaged && <ManageSubscriptionButton isPrimaryAction={hasPaymentIssue} />}
                      <SubscribeButton
                        priceId={plan.priceId}
                        planName={plan.name}
                        cancellableSubscriptions={cancellableSubscriptions}
                      />
                    </Stack>
                  }
                />
              );
            })}
          </>
        )}

        {selectedTab === SubscriptionModalTabs.Business && (
          <>
            <PlanCard
              name={t('subscription_modal.team')}
              description="Collaborative AI workspace with shared resources and advanced project management."
              price={teamPlanMinimumPrice}
              credits={teamPlanCredits}
              answersEstimate={formatAnswersEstimate(teamPlanCredits, answerCostReference)}
              interval="month"
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
                'Dedicated support channel',
                'Priority support',
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
                    <Typography
                      level="body-sm"
                      color="danger"
                      textAlign="center"
                      data-testid="subscription-modal-team-unavailable"
                    >
                      Team pricing is unavailable right now. Please try again later.
                    </Typography>
                  )}
                </Stack>
              }
            />
          </>
        )}
      </Box>
    </>
  );
};

export default SubscriptionModal;

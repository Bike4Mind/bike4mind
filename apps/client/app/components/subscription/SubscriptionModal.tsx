import { useCreateTeamModal } from '@client/app/components/organizations/CreateTeamModal';
import { useGetSettingsValue, useConfig } from '@client/app/hooks/data/settings';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import {
  SubscriptionPlanInterval,
  UserSubscriptionTier,
  SubscriptionPlanDetail,
} from '@client/lib/userSubscriptions/types';
import {
  Box,
  Button,
  CircularProgress,
  Modal,
  ModalClose,
  ModalDialog,
  Tab,
  tabClasses,
  TabList,
  Tabs,
  Typography,
  useTheme,
} from '@mui/joy';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SubscribeButton from '../Credits/SubscribeButton';
import PlanCard from './PlanCard';

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
  const [activeTab, setActiveTab] = useState<SubscriptionModalTabs>(SubscriptionModalTabs.Personal);
  const enableTeamPlan = useGetSettingsValue('enableTeamPlan');
  const { data: config } = useConfig();
  const seedStageName = config?.seedStageName || process.env.NEXT_PUBLIC_SEED_STAGE_NAME || '';
  const isTestMode = seedStageName !== 'production';

  const subscriptions = useGetSubscriptions({ enabled: true });
  const plans = useGetSubscriptionPlans();
  const activePlans = useMemo(() => (plans.data ?? []).filter(plan => plan.active), [plans.data]);
  const activeSubscriptions = useMemo(
    () => (subscriptions.data ?? []).filter(sub => sub.status === 'active'),
    [subscriptions.data]
  );
  const openCreateTeamModal = useCreateTeamModal(state => state.open);
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

  // Build subscription plans based on runtime stage
  const subscriptionPlans: SubscriptionPlanDetail[] = useMemo(
    () => [
      {
        // Account-tied Stripe price from NEXT_PUBLIC_* env vars (no brand fallback). Same env
        // contract as PROFESSIONAL_PRICE_ID in userSubscriptions/constants; selected by runtime
        // stage here to match the rest of this modal.
        priceId: isTestMode
          ? (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_TEST ?? '')
          : (process.env.NEXT_PUBLIC_STRIPE_PRICE_PRO_PROD ?? ''),
        interval: SubscriptionPlanInterval.Monthly,
        name: 'Professional',
        credits: 50000,
        tier: UserSubscriptionTier.Basic,
        features: [
          'Access to 25+ AI models including GPT-4, Claude 3, Gemini',
          'Self-hosted Deepseek R1 & Phi-4 for private inference',
          'Automatic model cost optimization',
          'Credits roll over for 3 months',
          'Advanced prompt engineering tools',
          'Single API for all models',
          'Priority support response',
        ],
        description: 'Access every major AI model through one unified interface, with smart cost optimization.',
      },
    ],
    [isTestMode]
  );

  const availablePlans = useMemo(
    () =>
      activeTab === SubscriptionModalTabs.Personal
        ? subscriptionPlans.filter(plan => activePlans.find(p => p.id === plan.priceId))
        : [],
    [activePlans, activeTab, subscriptionPlans]
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
        <Box
          component="span"
          sx={{
            textDecoration: 'underline',
            color: theme.palette.subscriptionModal.linkColor,
            fontWeight: '500',
          }}
        >
          {t('subscription_modal.no_free_tier')}
        </Box>{' '}
        {t('subscription_modal.credits_rollover')}
      </Typography>

      <Box sx={{ mb: '24px', display: 'flex', justifyContent: 'center' }}>
        <Tabs
          value={activeTab}
          onChange={(_, value) => setActiveTab(value as SubscriptionModalTabs)}
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

            <Tab disableIndicator value={SubscriptionModalTabs.Business} disabled={!enableTeamPlan}>
              {t('subscription_modal.business')}
            </Tab>
          </TabList>
        </Tabs>
      </Box>

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'center',
          gap: '32px',
        }}
      >
        {activeTab === SubscriptionModalTabs.Personal && (
          <>
            {availablePlans.map(plan => {
              const isCurrentPlan = activeSubscriptions.find(sub => sub.priceId === plan.priceId);
              return (
                <PlanCard
                  key={plan.priceId}
                  name={plan.name}
                  credits={plan.credits}
                  description={plan.description}
                  price={centsToDollars(priceMap?.[plan.priceId])}
                  interval={plan.interval}
                  features={plan.features}
                  isPopular={plan.name === 'Professional'}
                  isCurrentPlan={!!isCurrentPlan}
                  currentPlanDetails={isCurrentPlan}
                  priceId={plan.priceId}
                  actionButton={<SubscribeButton priceId={plan.priceId} activeSubscriptions={activeSubscriptions} />}
                />
              );
            })}
          </>
        )}

        {activeTab === SubscriptionModalTabs.Business && (
          <>
            <PlanCard
              name={t('subscription_modal.team')}
              description="Collaborative AI workspace with shared resources and advanced project management."
              price={100}
              interval="month"
              features={[
                '4 team member accounts included',
                'Shared credit pool with 3-month rollover',
                'Advanced Projects with RAG & Auto-Summary',
                'Team workspace & knowledge management',
                'Automated tagging & organization',
                'Usage analytics across all models',
                'Advanced security controls',
                'Dedicated support channel',
              ]}
              actionButton={
                <Button variant="solid" color="primary" fullWidth onClick={openCreateTeamModal}>
                  Create Team
                </Button>
              }
            />

            {/* <PlanCard
              name={t('subscription_modal.enterprise')}
              description="Collaborative AI workspace with shared resources and advanced project management."
              features={[
                'Private Deepseek R1 & Phi-4 deployment',
                'Custom AWS infrastructure setup',
                'White-label deployment option',
                'Full source code access',
                'Custom model fine-tuning',
                'Dedicated account manager',
                'Custom SLA & support',
                'Security audit & compliance support',
              ]}
              actionButton={
                <Button variant="solid" color="primary" fullWidth disabled>
                  Contact Sales
                </Button>
              }
            /> */}
          </>
        )}
      </Box>
    </>
  );
};

export default SubscriptionModal;

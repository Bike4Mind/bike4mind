import ProfileDetailSection from '@client/app/components/profile/ProfileDetailSection';
import ChangeEmailCard from '@client/app/components/profile/ChangeEmailCard';
import SectionContainer from '@client/app/components/ProfileModal/SectionContainer';
import Bike4MindIcon from '@client/app/components/svgs/icons/Bike4MindIcon';
import SubscriptionModal from '@client/app/components/subscription/SubscriptionModal';
import CreditsModal from '@client/app/components/subscription/CreditsModal';
import { useUser } from '@client/app/contexts/UserContext';
import { Box, Typography, IconButton, Tooltip, CircularProgress, Button } from '@mui/joy';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import ShoppingCartOutlinedIcon from '@mui/icons-material/ShoppingCartOutlined';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import dynamic from 'next/dynamic';
import prettyBytes from 'pretty-bytes';
import { useMemo, useState, useEffect } from 'react';

const ProfileCollectionSection = dynamic(() => import('@client/app/components/profile/ProfileCollectionSection'));
import { useTranslation } from 'react-i18next';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { AdminPanelSettings, Storage } from '@mui/icons-material';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { SUBSCRIPTION_PLANS } from '@client/lib/userSubscriptions/constants';
import { useGetSubscriptionPlans, useStripePortal } from '@client/app/hooks/data/stripe';
import dayjs from 'dayjs';
import { useTheme } from '@mui/joy';
import { SubscriptionOwnerType } from '@client/lib/subscriptions/types';
import { useToggleShowCreditsUsed } from '@client/app/hooks/data/user';

function centsToDollars(cents: number | undefined) {
  if (cents === undefined) return 0;
  return cents / 100;
}

const AboutTabContent = () => {
  const { currentUser, refreshUser } = useUser();
  const { t } = useTranslation();
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);
  const theme = useTheme();
  const toggleShowCreditsUsed = useToggleShowCreditsUsed();

  useEffect(() => {
    if (!creditsModalOpen) {
      refreshUser();
    }
  }, [creditsModalOpen, refreshUser]);

  return (
    <Box className="profile-detail-tab-root" sx={{ display: 'grid', gap: '1.25rem' }}>
      {currentUser?.id && <ProfileDetailSection canEdit userId={currentUser.id} />}

      <ChangeEmailCard />

      <Box
        className="profile-detail-tab-content-container"
        sx={{
          display: 'flex',
          gap: '1.25rem',
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
        }}
      >
        <SubscriptionCard />
        <SectionContainer>
          <Box
            className="profile-detail-tab-credits-section"
            sx={{
              display: 'flex',
              alignItems: 'top',
              gap: '15px',
              height: '144px',
            }}
          >
            <Box className="profile-detail-tab-icon-container" sx={{ flexShrink: 1 }}>
              <Bike4MindIcon size="38" fill={theme.palette.fileBrowser.fileSizeColor} />
            </Box>

            <Box
              className="profile-detail-tab-content"
              display="flex"
              flexDirection="column"
              justifyContent="space-between"
              sx={{ flex: 1 }}
            >
              <Box>
                <Typography
                  className="profile-detail-tab-label"
                  sx={{ color: 'neutral.500', fontSize: '14px', lineHeight: '14px', mb: '15px' }}
                >
                  {t('profile.credits')}
                </Typography>
                <Box
                  className="profile-detail-tab-value"
                  sx={{ fontWeight: '500', fontSize: '20px', lineHeight: '20px', mb: '10px' }}
                >
                  {currentUser?.currentCredits ?? 0}
                </Box>
              </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <SquareSlideToggle
                  checked={currentUser?.showCreditsUsed ?? false}
                  onChange={event => {
                    toggleShowCreditsUsed.mutate(event.target.checked);
                  }}
                />
                <Typography level="body-xs" sx={{ color: 'text.secondary', fontSize: '12px' }}>
                  Display credit usage in replies
                </Typography>
              </Box>
            </Box>

            <Tooltip title={t('profile.buy_credits')} placement="top">
              <IconButton
                className="profile-detail-tab-action-button"
                size="sm"
                variant="outlined"
                color="neutral"
                sx={{
                  position: 'absolute',
                  top: '10px',
                  right: '10px',
                }}
                onClick={() => setCreditsModalOpen(true)}
              >
                <ShoppingCartOutlinedIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </SectionContainer>

        <SectionContainer>
          <Box
            className="profile-detail-tab-storage-section"
            sx={{
              display: 'flex',
              alignItems: 'top',
              gap: '15px',
              height: '144px',
            }}
          >
            <Box sx={{ flexShrink: 1 }}>
              <Storage sx={{ fontSize: '38px', color: theme.palette.fileBrowser.fileSizeColor }} />
            </Box>

            <Box display="flex" flexDirection="column" justifyContent="space-between">
              <Box>
                <Typography
                  className="profile-detail-tab-subscription-label"
                  sx={{ color: 'neutral.500', fontSize: '14px', lineHeight: '14px', mb: '15px' }}
                >
                  {t('profile.storage_used')}
                </Typography>
                <Typography
                  className="profile-detail-tab-storage-value"
                  sx={{ fontWeight: '500', fontSize: '20px', lineHeight: '20px', mb: '20px' }}
                >
                  {prettyBytes(currentUser?.currentStorageSize ?? 0)} /{' '}
                  {prettyBytes((currentUser?.storageLimit ?? 0) * 1000000)}
                </Typography>
              </Box>
            </Box>
          </Box>
        </SectionContainer>
      </Box>

      {currentUser?.id && <ProfileCollectionSection userId={currentUser.id} />}

      {/* Credits Modal */}
      <CreditsModal open={creditsModalOpen} onClose={() => setCreditsModalOpen(false)} />
    </Box>
  );
};

const SubscriptionCard = () => {
  const [subscriptionModalOpen, setSubscriptionModalOpen] = useState(false);
  const { t } = useTranslation();
  const theme = useTheme();
  const stripePortal = useStripePortal();
  const { currentUser } = useUser();
  const subscriptions = useGetSubscriptions({ enabled: true });
  const subscription = (subscriptions.data || []).find(sub => sub.status === 'active');
  const subscriptionPlan = SUBSCRIPTION_PLANS.find(plan => plan.priceId === subscription?.priceId);
  const plans = useGetSubscriptionPlans();
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

  return (
    <SectionContainer>
      <Box
        className="profile-detail-tab-subscription-section"
        sx={{
          display: 'flex',
          alignItems: 'top',
          gap: '15px',
          height: '144px',
        }}
      >
        <Box sx={{ flexShrink: 1 }}>
          <AdminPanelSettings sx={{ fontSize: '48px', color: theme.palette.fileBrowser.fileSizeColor }} />
        </Box>

        {subscriptions.isPending || plans.isPending ? (
          <CircularProgress />
        ) : (
          <Box display="flex" flexDirection="column" justifyContent="space-between">
            <Box>
              <Typography sx={{ color: 'neutral.500', fontSize: '14px', lineHeight: '14px', mb: '15px' }}>
                {t('profile.subscription')}
              </Typography>
              <Box className="profile-detail-tab-subscription-value">
                <Typography sx={{ fontWeight: '500', fontSize: '20px', lineHeight: '20px' }}>
                  {subscriptionPlan?.name || 'None'}
                </Typography>
                {subscription && (
                  <Typography
                    className="profile-detail-tab-subscription-price"
                    sx={{ marginTop: '15px', fontWeight: 'normal', color: 'primary.500' }}
                  >
                    ${centsToDollars(priceMap?.[subscription?.priceId])}/{subscriptionPlan?.interval}
                  </Typography>
                )}
              </Box>
            </Box>
            {!subscription && (
              <Button
                className="profile-detail-tab-subscription-upgrade-button"
                data-testid="subscription-upgrade-btn"
                size="sm"
                color="primary"
                startDecorator={<AutoAwesomeIcon sx={{ fontSize: 16 }} />}
                onClick={() => setSubscriptionModalOpen(true)}
                sx={{ alignSelf: 'flex-start' }}
              >
                {t('profile.upgrade')}
              </Button>
            )}
            {subscription && (
              <Box
                className="profile-detail-tab-subscription-date"
                sx={{
                  fontSize: '14px',
                  lineHeight: '14px',
                  color: subscription.canceledAt ? 'warning.400' : 'neutral.500',
                }}
              >
                {t(subscription.canceledAt ? 'subscriptions.expires_on' : 'subscriptions.renews_on', {
                  // TODO: Pass locale to dayjs, as well as dynamically import dayjs/locales for the user's locale from useLanguage
                  date: dayjs(subscription?.periodEndsAt).format('MMMM DD, YYYY'),
                })}
              </Box>
            )}
          </Box>
        )}

        <Tooltip title={t(subscription ? 'profile.manage_subscription' : 'profile.upgrade')} placement="top">
          <IconButton
            className="profile-detail-tab-subscription-button"
            data-testid="subscription-corner-btn"
            aria-label={t(subscription ? 'profile.manage_subscription' : 'profile.upgrade')}
            size="sm"
            variant={subscription ? 'outlined' : 'solid'}
            color={subscription ? 'neutral' : 'primary'}
            sx={{
              position: 'absolute',
              top: '10px',
              right: '10px',
            }}
            onClick={() => {
              // If user has an active subscription, open the stripe portal
              if (subscription && currentUser) {
                stripePortal.mutate(
                  { ownerType: SubscriptionOwnerType.User, ownerId: currentUser.id },
                  {
                    // Store the return path only on success so a failed mutation doesn't leave an
                    // orphaned key that causes a spurious redirect on the next "/" load.
                    onSuccess: () => {
                      sessionStorage.setItem('__stripe_return', window.location.pathname);
                    },
                  }
                );
                return;
              }

              // Otherwise, open the subscription modal
              setSubscriptionModalOpen(true);
            }}
          >
            {subscription ? <SettingsOutlinedIcon sx={{ fontSize: 18 }} /> : <AutoAwesomeIcon sx={{ fontSize: 18 }} />}
          </IconButton>
        </Tooltip>
      </Box>

      {/* Subscription Modal */}
      <SubscriptionModal open={subscriptionModalOpen} onClose={() => setSubscriptionModalOpen(false)} />
    </SectionContainer>
  );
};

export default AboutTabContent;

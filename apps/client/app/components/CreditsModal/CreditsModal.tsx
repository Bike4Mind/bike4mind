import PaymentButton from '@client/app/components/Credits/PaymentButton';
import SubscribeButton from '@client/app/components/Credits/SubscribeButton';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useGetSubscriptionPlans } from '@client/app/hooks/data/stripe';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { CREDIT_PACKAGES } from '@client/lib/credits/constants';
import { TransactionType } from '@client/lib/credits/types';
import { SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL } from '@client/lib/userSubscriptions/constants';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { Box, Button, Card, IconButton, Modal, ModalDialog, Tab, TabList, TabPanel, Tabs, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useSelectedAccount } from '@client/app/components/Credits/AccountSelector';

enum CreditsModalTabs {
  PayAsYouGo,
  Monthly,
  Yearly,
}

type CreditsModalStore = {
  isOpen: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

export const useCreditsModal = create<CreditsModalStore>(set => ({
  isOpen: false,
  setOpen: open => set({ isOpen: open }),
  toggle: () => set(state => ({ isOpen: !state.isOpen })),
}));

function centsToDollars(cents: number | undefined) {
  if (cents === undefined) return 0;
  return cents / 100;
}

const creditPackages = Object.values(CREDIT_PACKAGES);

const CreditsModal = () => {
  const { isOpen, setOpen } = useCreditsModal();
  const { t } = useTranslation();
  const isCreditsEnabled = useGetSettingsValue('enforceCredits');
  const subscriptions = useGetSubscriptions({ enabled: isOpen });
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();
  const plans = useGetSubscriptionPlans();
  const { selectedAccount } = useSelectedAccount();

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

  useEffect(() => {
    const unsubscribe = subscribeToAction('invalidate_query', async msg => {
      if (msg.action !== 'invalidate_query') return;
      queryClient.invalidateQueries({ queryKey: msg.queryKey });
    });

    return () => {
      unsubscribe();
    };
  }, [isOpen, queryClient, subscribeToAction]);

  const handlePaymentComplete = useCallback((credits: number) => {
    toast.success(`Purchased ${credits} credits`);
  }, []);

  const activeSubscriptions = useMemo(
    () => (subscriptions.data ?? []).filter(sub => sub.status === 'active'),
    [subscriptions.data]
  );

  const hasPaymentIssues = useMemo(() => {
    return (subscriptions.data ?? []).some(sub => sub.status !== 'active' && sub.status !== 'canceled');
  }, [subscriptions.data]);

  // Hide Pay As You Go tab when selected account is an organization
  const showPayAsYouGoTab = useMemo(() => {
    // Only show if selected account is personal (or no account selected yet)
    return !selectedAccount || selectedAccount.personal;
  }, [selectedAccount]);

  return (
    <Modal open={isOpen} onClose={() => setOpen(false)}>
      <ModalDialog
        sx={{
          minWidth: '80%',
          maxWidth: '1200px',
          minHeight: '80%',
          maxHeight: '1200px',
          borderRadius: 'md',
          p: 3,
          boxShadow: 'lg',
          position: 'relative',
          overflow: 'auto',
        }}
      >
        <IconButton
          onClick={() => setOpen(false)}
          sx={{
            position: 'absolute',
            top: '10px',
            right: '10px',
            zIndex: 1,
          }}
        >
          <CloseRoundedIcon />
        </IconButton>

        {isCreditsEnabled ? (
          <>
            <Typography level="h4" component="h2" sx={{ mb: 2, pr: 4 }}>
              {t('Buy Credits')}
            </Typography>
            <Tabs
              defaultValue={
                activeSubscriptions.length > 0 && showPayAsYouGoTab
                  ? CreditsModalTabs.PayAsYouGo
                  : CreditsModalTabs.Monthly
              }
              sx={{ mb: 2 }}
            >
              <TabList>
                {activeSubscriptions.length > 0 && showPayAsYouGoTab && (
                  <Tab value={CreditsModalTabs.PayAsYouGo}>{t('Pay As You Go')}</Tab>
                )}
                <Tab value={CreditsModalTabs.Monthly}>{t('Monthly')}</Tab>
                <Tab value={CreditsModalTabs.Yearly}>{t('Yearly')}</Tab>
              </TabList>
              <TabPanel value={CreditsModalTabs.PayAsYouGo}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2 }}>
                  {creditPackages.slice(0, 3).map(pkg => (
                    <Card
                      key={pkg.credits}
                      variant="outlined"
                      sx={{
                        p: 2,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 1,
                        height: '60vh',
                        '&:hover': {
                          borderColor: 'primary.500',
                        },
                      }}
                    >
                      <Typography level="h1">{pkg.credits.toLocaleString()} Credits</Typography>
                      <Typography level="body-md">${pkg.price}</Typography>
                      <PaymentButton
                        transactionType={TransactionType.Package}
                        packageId={pkg.id}
                        onPayment={() => handlePaymentComplete(pkg.credits)}
                      />
                    </Card>
                  ))}
                </Box>
              </TabPanel>
              <TabPanel value={CreditsModalTabs.Monthly}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 2 }}>
                  {/* Show alert if user has payment issues */}
                  {hasPaymentIssues && (
                    <Card
                      variant="outlined"
                      sx={{
                        p: 2,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 1,
                        height: '60vh',
                        borderColor: 'error.500',
                      }}
                    >
                      <Typography level="h2">{t('Payment Issues')}</Typography>
                      <Typography level="body-md">
                        {t('You have payment issues with your current subscription.')}
                      </Typography>
                      <Button onClick={() => setOpen(false)} sx={{ mt: 2 }}>
                        Close
                      </Button>
                    </Card>
                  )}

                  {Object.values(SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL.monthly).map(plan => (
                    <Card
                      key={plan.name}
                      variant="outlined"
                      sx={{
                        p: 2,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 1,
                        height: '60vh',
                        '&:hover': {
                          borderColor: 'primary.500',
                        },
                      }}
                    >
                      <Typography level="h2">{plan.name}</Typography>
                      <Typography level="h3">{plan.credits.toLocaleString()} Credits</Typography>
                      <Typography level="body-md">${centsToDollars(priceMap?.[plan.priceId])}/month</Typography>
                      <Typography level="body-sm" sx={{ textAlign: 'center', mb: 1 }}>
                        {(plan.credits / 30000).toFixed(0)} conversations per day
                      </Typography>
                      <SubscribeButton priceId={plan.priceId} activeSubscriptions={activeSubscriptions} />
                    </Card>
                  ))}
                </Box>
              </TabPanel>
              <TabPanel value={CreditsModalTabs.Yearly}>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 2 }}>
                  {Object.values(SUBSCRIPTION_PLANS_GROUPED_BY_INTERVAL.yearly).map(plan => (
                    <Card
                      key={plan.name}
                      variant="outlined"
                      sx={{
                        p: 2,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 1,
                        height: '60vh',
                        '&:hover': {
                          borderColor: 'primary.500',
                        },
                      }}
                    >
                      <Typography level="h2">{plan.name}</Typography>
                      <Typography level="h3">{plan.credits.toLocaleString()} Credits</Typography>
                      <Typography level="body-md">${centsToDollars(priceMap?.[plan.priceId])}/year</Typography>
                      <Typography level="body-sm" sx={{ textAlign: 'center', mb: 1 }}>
                        {(plan.credits / 365000).toFixed(0)} conversations per day
                      </Typography>
                      <SubscribeButton priceId={plan.priceId} activeSubscriptions={activeSubscriptions} />
                    </Card>
                  ))}
                </Box>
              </TabPanel>
            </Tabs>
          </>
        ) : (
          <Box sx={{ textAlign: 'center' }}>
            <Typography level="h4" component="h2" sx={{ mb: 2 }}>
              {t('Credits Enforcement is Off')}
            </Typography>
            <Typography level="body-md">The Credits Enforcement system is currently disabled.</Typography>
            <Typography level="body-md">You can use the application without purchasing! Woot! credits.</Typography>
            <Button onClick={() => setOpen(false)} sx={{ mt: 2 }}>
              Close
            </Button>
          </Box>
        )}
      </ModalDialog>
    </Modal>
  );
};

export default CreditsModal;

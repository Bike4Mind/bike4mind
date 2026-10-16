import { Box, Button, DialogTitle, Modal, ModalClose, ModalDialog, Skeleton, Typography } from '@mui/joy';
import dayjs from 'dayjs';
import { ReactNode, RefObject, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useGetCreditTransactions } from '@client/app/hooks/data/credits';
import { useGetSubscriptions } from '@client/app/hooks/data/subscriptions';
import { useLowCreditsThreshold } from '@client/app/hooks/data/teamPlanSettings';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import type { BillingView } from '@client/app/utils/billingDeepLink';
import { isDelinquentSubscriptionStatus, pickDisplayedSubscription } from '@client/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS_MAP } from '@client/lib/userSubscriptions/constants';
import { CreditsSection } from './CreditsSection';
import { PlansSection, PlansSectionSkeleton } from './PlansSection';

interface BillingModalProps {
  open: boolean;
  /** Section to scroll to and focus on open: `?billing=credits|plans` or the entry point's intent. */
  focus: BillingView;
  onClose: () => void;
}

const statLabelSx = {
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 600,
  color: 'text.tertiary',
} as const;

const Section = ({
  view,
  title,
  subtitle,
  headingRef,
  isFocusTarget,
  children,
}: {
  view: BillingView;
  title: string;
  subtitle: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Scroll here and focus the heading on mount, and again whenever this becomes the target. */
  isFocusTarget: boolean;
  children: ReactNode;
}) => {
  // Runs in the section, not the modal: the Portal mounts the dialog body a commit after the modal
  // itself, so an effect up there would find no heading yet.
  useEffect(() => {
    const heading = headingRef.current;
    if (!isFocusTarget || !heading) return;
    heading.focus({ preventScroll: true });
    heading.closest('section')?.scrollIntoView?.({ block: 'start' });
  }, [isFocusTarget, headingRef]);

  return (
    <Box
      component="section"
      data-testid={`billing-section-${view}`}
      aria-labelledby={`billing-section-${view}-heading`}
      sx={{ scrollMarginTop: '16px' }}
    >
      <Typography
        ref={headingRef}
        id={`billing-section-${view}-heading`}
        data-testid={`billing-section-${view}-heading`}
        level="title-lg"
        component="h3"
        tabIndex={-1}
        sx={{
          fontWeight: 600,
          // A programmatic focus target (tabIndex -1), never a tab stop, so no ring.
          outline: 'none',
        }}
      >
        {title}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', mt: 0.25, mb: 2 }}>
        {subtitle}
      </Typography>
      {children}
    </Box>
  );
};

/**
 * The Billing modal: one scrolling view that always opens on the user's current state (balance and
 * plan), then sells. Without a plan in good standing the plans section leads, since a subscription is
 * the upgrade; with one, credit top-ups lead and plan changes follow. `focus` only scrolls - it never
 * reorders - so `?billing=credits` and `?billing=plans` land on the same page.
 *
 * The dialog has a fixed size (full-screen sheet on phones) and only the body scrolls, so loading
 * states and section order never resize it.
 */
const BillingModal = ({ open, focus, onClose }: BillingModalProps) => {
  const { t } = useTranslation();
  const transactions = useGetCreditTransactions({ enabled: open });
  const subscriptions = useGetSubscriptions({ enabled: open });
  const credits = useEffectiveCredits();
  const lowCreditsThreshold = useLowCreditsThreshold();
  const noCredits = credits <= 0;
  const isLowCredits = credits < lowCreditsThreshold;

  // The shared display rule (lib/subscriptions/types), so this header and the plan card agree on the row.
  const currentSubscription = useMemo(() => pickDisplayedSubscription(subscriptions.data ?? []), [subscriptions.data]);
  const hasPaymentIssue = !!currentSubscription && isDelinquentSubscriptionStatus(currentSubscription.status);
  // A failed payment keeps plans on top: fixing the card is the action that matters.
  const plansFirst = !currentSubscription || hasPaymentIssue;
  const ready = !subscriptions.isPending;

  const plansHeadingRef = useRef<HTMLHeadingElement>(null);
  const creditsHeadingRef = useRef<HTMLHeadingElement>(null);

  const scrollTo = (view: BillingView) => {
    const heading = (view === 'plans' ? plansHeadingRef : creditsHeadingRef).current;
    heading?.closest('section')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    heading?.focus({ preventScroll: true });
  };

  const planName = currentSubscription
    ? (SUBSCRIPTION_PLANS_MAP[currentSubscription.priceId]?.name ?? t('billing.plan_fallback', 'Subscription'))
    : t('billing.free_plan', 'Free');
  const planDetail = !currentSubscription
    ? t('billing.free_plan_detail', 'Pay as you go with credit packs')
    : hasPaymentIssue
      ? t('billing.payment_failed', 'Payment failed')
      : currentSubscription.canceledAt
        ? t('subscriptions.expires_on', { date: dayjs(currentSubscription.periodEndsAt).format('MMM D, YYYY') })
        : t('subscriptions.renews_on', { date: dayjs(currentSubscription.periodEndsAt).format('MMM D, YYYY') });

  const plansSection = (
    <Section
      key="plans"
      view="plans"
      headingRef={plansHeadingRef}
      isFocusTarget={focus === 'plans'}
      title={currentSubscription ? t('billing.plans_change', 'Your plan') : t('billing.plans_upgrade', 'Upgrade')}
      subtitle={
        currentSubscription
          ? t('billing.plans_change_sub', 'Manage, change or cancel your subscription.')
          : t('billing.plans_upgrade_sub', 'Get a monthly credit allowance instead of topping up by hand.')
      }
    >
      <PlansSection />
    </Section>
  );
  const creditsSection = (
    <Section
      key="credits"
      view="credits"
      headingRef={creditsHeadingRef}
      isFocusTarget={focus === 'credits'}
      title={t('billing.credits_heading', 'Top up credits')}
      subtitle={
        currentSubscription
          ? t('billing.credits_sub_with_plan', 'One-time packs, added on top of your monthly allowance.')
          : t('billing.credits_sub', 'One-time packs, added to your balance. No subscription needed.')
      }
    >
      <CreditsSection
        transactions={transactions.data ?? []}
        transactionsLoading={transactions.isPending}
        onClose={onClose}
      />
    </Section>
  );

  return (
    <Modal open={open} onClose={onClose} data-testid="billing-modal">
      <ModalDialog
        data-testid="billing-modal-dialog"
        sx={{
          p: 0,
          gap: 0,
          overflow: 'hidden',
          width: { xs: '100vw', sm: 'min(880px, calc(100vw - 48px))' },
          maxWidth: { xs: '100vw', sm: 'calc(100vw - 48px)' },
          height: { xs: '100dvh', sm: 'min(760px, calc(100dvh - 48px))' },
          maxHeight: { xs: '100dvh', sm: 'calc(100dvh - 48px)' },
          borderRadius: { xs: 0, sm: 'xl' },
          bgcolor: 'background.surface',
          boxShadow: 'lg',
        }}
      >
        <Box
          component="header"
          sx={{
            px: { xs: 2.5, sm: 4 },
            pt: { xs: 2.5, sm: 3 },
            pb: 2.5,
            borderBottom: '1px solid',
            borderColor: 'divider',
          }}
        >
          <DialogTitle level="title-lg" sx={{ fontWeight: 600, mb: 2 }}>
            {t('billing.title', 'Billing')}
          </DialogTitle>
          <ModalClose data-testid="billing-modal-close" sx={{ top: { xs: 16, sm: 20 }, right: { xs: 16, sm: 24 } }} />
          <Box sx={{ display: 'flex', gap: { xs: 3, sm: 6 }, alignItems: 'flex-start' }}>
            <Box data-testid="billing-balance">
              <Typography level="body-xs" sx={statLabelSx}>
                {t('billing.balance', 'Balance')}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mt: 0.5 }}>
                <Typography
                  component="span"
                  sx={{
                    fontSize: { xs: '1.75rem', sm: '2.25rem' },
                    lineHeight: 1,
                    fontWeight: 600,
                    letterSpacing: '-0.02em',
                    fontVariantNumeric: 'tabular-nums',
                    color: noCredits ? 'danger.plainColor' : isLowCredits ? 'warning.plainColor' : 'text.primary',
                  }}
                >
                  {formatCreditAmount(credits)}
                </Typography>
                <Typography component="span" level="body-sm" sx={{ color: 'text.tertiary' }}>
                  {t('credits.unit', 'credits')}
                </Typography>
              </Box>
            </Box>
            <Box data-testid="billing-current-plan">
              <Typography level="body-xs" sx={statLabelSx}>
                {t('billing.plan', 'Plan')}
              </Typography>
              {ready ? (
                <Box sx={{ mt: 0.5 }}>
                  <Typography level="title-md" sx={{ fontWeight: 600 }}>
                    {planName}
                  </Typography>
                  <Typography level="body-xs" sx={{ color: hasPaymentIssue ? 'danger.plainColor' : 'text.tertiary' }}>
                    {planDetail}
                  </Typography>
                </Box>
              ) : (
                <Box sx={{ mt: 0.5 }}>
                  <Skeleton variant="text" level="title-md" sx={{ width: 120 }} />
                  <Skeleton variant="text" level="body-xs" sx={{ width: 160 }} />
                </Box>
              )}
            </Box>
          </Box>
          {(noCredits || isLowCredits) && (
            <Box
              role="status"
              data-testid="billing-low-balance"
              sx={{
                mt: 2,
                px: 1.5,
                py: 1,
                borderRadius: 'md',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 1.5,
                flexWrap: 'wrap',
                bgcolor: noCredits ? 'danger.softBg' : 'warning.softBg',
                color: 'text.primary',
              }}
            >
              <Typography level="body-sm" sx={{ color: 'inherit' }}>
                <Box
                  component="strong"
                  sx={{ fontWeight: 600, color: noCredits ? 'danger.plainColor' : 'warning.plainColor' }}
                >
                  {noCredits ? t('credits_modal.no_credits') : t('credits_modal.low_credits')}.
                </Box>{' '}
                {currentSubscription
                  ? t('billing.low_with_plan', 'Top up to keep working until your allowance renews.')
                  : t('billing.low_without_plan', 'A plan adds credits every month; a pack tops you up now.')}
              </Typography>
              {ready && (
                <Button
                  size="sm"
                  variant="plain"
                  color={noCredits ? 'danger' : 'warning'}
                  data-testid="billing-low-balance-action"
                  onClick={() => scrollTo(currentSubscription ? 'credits' : 'plans')}
                >
                  {currentSubscription ? t('billing.top_up', 'Top up') : t('billing.see_plans', 'See plans')}
                </Button>
              )}
            </Box>
          )}
        </Box>

        <Box
          data-testid="billing-modal-body"
          sx={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            px: { xs: 2.5, sm: 4 },
            py: 3,
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
          }}
        >
          {open &&
            (ready ? (
              plansFirst ? (
                [plansSection, creditsSection]
              ) : (
                [creditsSection, plansSection]
              )
            ) : (
              <Box aria-busy="true" sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <PlansSectionSkeleton />
                <Skeleton variant="rectangular" sx={{ borderRadius: 'lg', height: 160 }} />
              </Box>
            ))}
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default BillingModal;

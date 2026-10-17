import { Box, Chip, Sheet, Typography } from '@mui/joy';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import CreditIcon from '@client/app/components/svgs/icons/CreditIcon';
import { formatCreditAmount } from '@client/app/utils/formatCredits';
import { formatPlanPrice } from './billingFormat';

// Plan intervals are stored as adjectives ('monthly'); the price reads "$30 / month".
const INTERVAL_UNIT: Record<string, string> = { monthly: 'month', yearly: 'year' };

interface PlanCardProps {
  name: string;
  credits?: number;
  /** "About N answers" line for `credits`; omitted when there is no priced reference model. */
  answersEstimate?: string | null;
  description: string;
  price?: number;
  interval?: string;
  features: string[];
  isPopular?: boolean;
  /** Accent outline for the plan the modal leads with; layout emphasis only, no badge text. */
  isFeatured?: boolean;
  isCurrentPlan?: boolean;
  /** True when the current plan's billing is stuck (past_due/unpaid/incomplete). */
  hasPaymentIssue?: boolean;
  currentPlanDetails?: {
    periodEndsAt: Date;
    canceledAt: Date | null;
  };
  priceId?: string;
  actionButton: React.ReactNode;
}

const PlanCard = ({
  name,
  credits,
  answersEstimate,
  description,
  price,
  interval,
  features,
  isPopular,
  isFeatured,
  isCurrentPlan,
  hasPaymentIssue,
  currentPlanDetails,
  actionButton,
}: PlanCardProps) => {
  const { t } = useTranslation();

  return (
    <Sheet
      variant="outlined"
      data-testid="plan-card"
      sx={{
        borderRadius: 'lg',
        p: { xs: 2.5, sm: 3 },
        bgcolor: 'background.surface',
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(0, 1.15fr) minmax(0, 1fr)' },
        gap: { xs: 2.5, sm: 4 },
        ...(isFeatured && {
          borderColor: 'primary.500',
          boxShadow: '0 0 0 1px var(--joy-palette-primary-500)',
        }),
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
          <Typography level="title-lg" sx={{ fontWeight: 600 }}>
            {name}
          </Typography>
          {isCurrentPlan && (
            <Chip size="sm" variant="soft" color={hasPaymentIssue ? 'danger' : 'neutral'}>
              {t('subscription_modal.current')}
            </Chip>
          )}
          {isPopular && (
            <Chip size="sm" variant="soft" color="primary" data-testid="plan-card-popular-badge">
              {t('subscription_modal.most_popular')}
            </Chip>
          )}
        </Box>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          {description}
        </Typography>

        {price && interval ? (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, mt: 2.5 }}>
            <Typography
              component="span"
              sx={{
                fontSize: '2.5rem',
                lineHeight: 1,
                fontWeight: 600,
                letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
                color: 'text.primary',
              }}
            >
              {formatPlanPrice(price)}
            </Typography>
            <Typography component="span" level="body-sm" sx={{ color: 'text.tertiary' }}>
              / {INTERVAL_UNIT[interval] ?? interval}
            </Typography>
          </Box>
        ) : null}

        {credits ? (
          <Typography
            level="body-sm"
            startDecorator={
              <CreditIcon
                aria-hidden
                data-testid="plan-card-credit-icon"
                sx={{ fontSize: '1.125rem', color: 'subscription.creditsModal.iconFill' }}
              />
            }
            sx={{ mt: 1.5, fontWeight: 500, color: 'text.primary' }}
          >
            {t('subscription_modal.credits_per_month', { credits: formatCreditAmount(credits) })}
          </Typography>
        ) : null}
        {credits && answersEstimate ? (
          <Typography level="body-xs" data-testid="plan-card-answers-estimate" sx={{ mt: 0.5, color: 'text.tertiary' }}>
            {answersEstimate}
          </Typography>
        ) : null}

        {isCurrentPlan && currentPlanDetails && !currentPlanDetails.canceledAt && (
          <Typography
            level="body-sm"
            sx={{
              mt: 2,
              px: 1.5,
              py: 1,
              borderRadius: 'sm',
              bgcolor: hasPaymentIssue ? 'danger.softBg' : 'background.level1',
              color: hasPaymentIssue ? 'danger.softColor' : 'text.secondary',
            }}
          >
            {/* A delinquent plan still renews on paper, so saying so would read as
                healthy - the user needs the reason their card was declined. */}
            {hasPaymentIssue
              ? t('subscriptions.payment_issue')
              : t('subscription_modal.subscription_renewal', {
                  date: dayjs(currentPlanDetails.periodEndsAt).format('MMM D, YYYY'),
                })}
          </Typography>
        )}

        <Box sx={{ mt: 'auto', pt: 2.5 }}>{actionButton}</Box>
      </Box>

      <Box
        sx={{
          minWidth: 0,
          pt: { xs: 2.5, sm: 0 },
          pl: { xs: 0, sm: 4 },
          // Longhands, so the breakpoint rule cannot reset the colour the way a `border` shorthand would.
          borderStyle: 'solid',
          borderColor: 'neutral.outlinedBorder',
          borderWidth: { xs: '1px 0 0 0', sm: '0 0 0 1px' },
        }}
      >
        <Typography
          level="body-xs"
          sx={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600, color: 'text.tertiary', mb: 1.5 }}
        >
          {t('subscription_modal.includes', 'Includes')}
        </Typography>
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
          {features?.map((feature, i) => (
            <Box component="li" key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
              <CheckRoundedIcon
                aria-hidden
                sx={{ fontSize: 18, mt: '1px', color: 'primary.plainColor', flexShrink: 0 }}
              />
              <Typography level="body-sm" sx={{ color: 'text.primary' }}>
                {feature}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </Sheet>
  );
};

export default PlanCard;

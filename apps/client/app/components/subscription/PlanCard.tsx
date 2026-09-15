import { Box, Typography, Divider } from '@mui/joy';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { blackAlpha } from '@client/app/utils/themes/colors';

interface PlanCardProps {
  name: string;
  credits?: number;
  description: string;
  price?: number;
  interval?: string;
  features: string[];
  isPopular?: boolean;
  isCurrentPlan?: boolean;
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
  description,
  price,
  interval,
  features,
  isPopular,
  isCurrentPlan,
  currentPlanDetails,
  actionButton,
}: PlanCardProps) => {
  const { t } = useTranslation();

  return (
    <Box
      sx={theme => ({
        maxWidth: '448px',
        border: '1px solid',
        borderColor: isPopular ? theme.palette.creditsModal.border : theme.palette.subscriptionModal.border,
        background: isPopular ? theme.palette.creditsModal.gradient : theme.palette.primary.softBg,
        borderRadius: '10px',
        p: '32px 24px 24px',
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
        transition: 'all 0.2s ease-in-out',
        '&:hover': {
          transform: 'translateY(-4px)',
          boxShadow: `0 6px 20px ${blackAlpha[0][20]}`,
          borderColor: isPopular ? theme.palette.creditsModal.gradient : 'neutral.600',
        },
        ...(isPopular
          ? {
              borderColor: 'primary.500',
              boxShadow: '0 0 0 1px var(--joy-palette-primary-500)',
            }
          : {}),
      })}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          top: 12,
          right: 12,
          position: 'absolute',
        }}
      >
        {isPopular && (
          <Box
            sx={{
              bgcolor: 'primary.500',
              color: 'white',
              px: 1.5,
              py: 0.5,
              borderRadius: 'lg',
              fontSize: 'sm',
              fontWeight: '500',
              lineHeight: '14px',
              height: 'fit-content',
            }}
          >
            {t('subscription_modal.most_popular')}
          </Box>
        )}
        {isCurrentPlan && (
          <Box
            sx={{
              border: '1px solid',
              borderColor: 'primary.500',
              color: 'primary.500',
              px: '10px',
              py: '8px',
              borderRadius: '60px',
              fontSize: '14px',
              lineHeight: '14px',
            }}
          >
            {t('subscription_modal.current')}
          </Box>
        )}
      </Box>
      <Typography sx={{ mb: '20px', fontSize: '24px', lineHeight: '24px' }}>{name}</Typography>
      {credits && (
        <Typography level="body-md" sx={{ mb: '32px', color: 'neutral.500' }}>
          {t('subscription_modal.credits_per_month', { credits: credits.toLocaleString() })}
        </Typography>
      )}
      <Typography level="body-md" sx={{ mb: '24px', color: 'neutral.400' }}>
        {description}
      </Typography>
      {price && interval && (
        <Typography sx={{ fontWeight: '600', fontSize: '32px', lineHeight: '32px', mb: '32px', color: 'primary.500' }}>
          ${price.toFixed(2)}{' '}
          <Typography level="body-sm" component="span" sx={{ color: 'primary.500' }}>
            / {interval}
          </Typography>
        </Typography>
      )}

      {isCurrentPlan && currentPlanDetails && !currentPlanDetails.canceledAt && (
        <Box sx={{ height: '95px', mb: '16px' }}>
          <Box
            sx={{
              fontSize: '14px',
              border: '1px solid',
              borderColor: 'neutral.700',
              borderRadius: '10px',
              width: '100%',
              py: '14px',
            }}
          >
            <Typography
              sx={{
                color: 'neutral.500',
                textAlign: 'center',
                fontSize: '14px',
                lineHeight: '14px',
                mb: '17px',
              }}
            >
              {t('subscription_modal.subscription_renewal', {
                date: dayjs(currentPlanDetails.periodEndsAt).format('MMM D, YYYY'),
              })}
            </Typography>
            <Box sx={{ fontSize: '16px', lineHeight: '16px', textAlign: 'center' }}>****</Box>
          </Box>
        </Box>
      )}

      {actionButton}
      <Divider sx={{ my: '20px' }} />

      <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {features?.map((feature, i) => (
          <Box key={i} sx={{ display: 'flex', alignItems: 'center' }}>
            <Box sx={{ width: '8px', height: '8px', borderRadius: '50%', mr: '12px', bgcolor: 'primary.500' }} />
            <Typography sx={{ lineHeight: '19px', fontSize: '14px' }}>{feature}</Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

export default PlanCard;

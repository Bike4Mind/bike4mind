import { Button, Stack, Typography } from '@mui/joy';
import { useTranslation } from 'react-i18next';
import { usePayFailedInvoice } from './usePayFailedInvoice';

type PayNowButtonProps = {
  /** Stripe subscription id (`sub_...`) of the delinquent plan. */
  subscriptionId: string;
  testId: string;
};

const PayNowButton = ({ subscriptionId, testId }: PayNowButtonProps) => {
  const { t } = useTranslation();
  const { pay, isPending, isPaid, declineMessage } = usePayFailedInvoice();

  return (
    <Stack gap={0.5}>
      <Button
        data-testid={testId}
        color="primary"
        variant="solid"
        loading={isPending}
        disabled={isPending || isPaid}
        onClick={() => pay(subscriptionId)}
      >
        {isPaid ? t('profile.pay_now_received') : t('profile.pay_now')}
      </Button>
      {declineMessage && (
        <Typography level="body-sm" color="danger" role="alert" data-testid={`${testId}-error`}>
          {declineMessage}
        </Typography>
      )}
    </Stack>
  );
};

export default PayNowButton;

import { Table, Typography, Stack, Box, Card, CardContent, Divider } from '@mui/joy';
import dayjs from 'dayjs';
import { SubscriptionData, PlanInfo } from '../types';
import SubscriptionStatusChip from './SubscriptionStatusChip';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

interface SubscriptionTableProps {
  subscriptions: SubscriptionData[];
  planMap: Record<string, PlanInfo>;
  isLoading?: boolean;
}

const SubscriptionTable = ({ subscriptions, planMap }: SubscriptionTableProps) => {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Stack spacing={1.5}>
        {subscriptions.map(subscription => {
          const plan = planMap[subscription.priceId];
          return (
            <Card key={subscription.id || subscription.subscriptionId} variant="outlined">
              <CardContent sx={{ p: 1.5 }}>
                <Stack spacing={0.75}>
                  <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                    <Typography fontWeight="bold">{subscription.user?.username || 'Unknown User'}</Typography>
                    <SubscriptionStatusChip subscription={subscription} />
                  </Stack>
                  <Typography level="body-xs" sx={{ wordBreak: 'break-word', color: 'text.secondary' }}>
                    {subscription.user?.email}
                  </Typography>
                  <Divider />
                  <Stack direction="row" justifyContent="space-between">
                    <Typography level="body-sm" fontWeight="md">
                      {plan?.name || 'Unknown Plan'}
                      {plan?.interval ? ` · ${plan.interval}` : ''}
                    </Typography>
                    <Typography level="body-sm">
                      {plan?.amount ? `$${plan.amount.toFixed(2)}/${plan.interval}` : 'N/A'}
                    </Typography>
                  </Stack>
                  <Typography level="body-xs" color="neutral">
                    {dayjs(subscription.periodStartsAt).format('MMM D, YYYY')} →{' '}
                    {dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}
                  </Typography>
                </Stack>
              </CardContent>
            </Card>
          );
        })}
      </Stack>
    );
  }

  return (
    <Box sx={{ overflowX: { xs: 'auto', sm: 'visible' } }}>
      <Table sx={{ minWidth: { xs: '900px', sm: 'auto' } }}>
        <thead>
          <tr>
            <th>User</th>
            <th>Plan</th>
            <th>Status</th>
            <th>Period Start</th>
            <th>Period End</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {subscriptions.map(subscription => {
            const plan = planMap[subscription.priceId];

            return (
              <tr key={subscription.id || subscription.subscriptionId}>
                <td>
                  <Stack>
                    <Typography>{subscription.user?.username || 'Unknown User'}</Typography>
                    <Typography level="body-xs" sx={{ wordBreak: 'break-word' }}>
                      {subscription.user?.email}
                    </Typography>
                  </Stack>
                </td>
                <td>
                  <Stack>
                    <Typography>{plan?.name || 'Unknown Plan'}</Typography>
                    <Typography level="body-xs">{plan?.interval || ''}</Typography>
                  </Stack>
                </td>
                <td>
                  <SubscriptionStatusChip subscription={subscription} />
                </td>
                <td>{dayjs(subscription.periodStartsAt).format('MMM D, YYYY')}</td>
                <td>{dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}</td>
                <td>
                  <Typography>{plan?.amount ? `$${plan.amount.toFixed(2)}/${plan.interval}` : 'N/A'}</Typography>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Box>
  );
};

export default SubscriptionTable;

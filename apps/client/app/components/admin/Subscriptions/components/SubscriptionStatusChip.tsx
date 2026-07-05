import { Box, Chip, Tooltip } from '@mui/joy';
import ScheduleIcon from '@mui/icons-material/Schedule';
import dayjs from 'dayjs';
import { SubscriptionData } from '../types';
import { useSubscriptionStatus } from '../hooks/useSubscriptionStatus';

interface SubscriptionStatusChipProps {
  subscription: SubscriptionData;
}

const SubscriptionStatusChip = ({ subscription }: SubscriptionStatusChipProps) => {
  const { getStatusDisplay } = useSubscriptionStatus();
  const statusDisplay = getStatusDisplay(subscription);
  const StatusIcon = statusDisplay.icon;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
      <Tooltip title={statusDisplay.tooltip} placement="top">
        <Chip
          color={statusDisplay.color}
          size="sm"
          startDecorator={<StatusIcon sx={{ fontSize: 16 }} />}
          variant={subscription.canceledAt && subscription.status === 'active' ? 'outlined' : 'solid'}
        >
          {statusDisplay.label}
        </Chip>
      </Tooltip>
      {subscription.canceledAt && subscription.status === 'active' && (
        <Tooltip
          title={`Subscription will cancel on ${dayjs(subscription.periodEndsAt).format('MMM D, YYYY')}`}
          placement="top"
        >
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <ScheduleIcon sx={{ fontSize: 16, color: 'warning.500' }} />
          </Box>
        </Tooltip>
      )}
    </Box>
  );
};

export default SubscriptionStatusChip;

import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import WarningIcon from '@mui/icons-material/Warning';
import ScheduleIcon from '@mui/icons-material/Schedule';
import ErrorIcon from '@mui/icons-material/Error';
import dayjs from 'dayjs';
import { StatusDisplay, SubscriptionData } from '../types';

export const useSubscriptionStatus = () => {
  const getStatusDisplay = (subscription: SubscriptionData): StatusDisplay => {
    const { status, canceledAt, periodEndsAt } = subscription;
    const isCanceled = !!canceledAt;

    const statusConfig: Record<string, StatusDisplay> = {
      active: {
        icon: CheckCircleIcon,
        color: 'success' as const,
        label: 'Active',
        tooltip: isCanceled
          ? `Active until ${dayjs(periodEndsAt).format('MMM D, YYYY')} (Canceled)`
          : 'Active subscription',
      },
      canceled: {
        icon: CancelIcon,
        color: 'neutral' as const,
        label: 'Canceled',
        tooltip: 'Subscription has been canceled',
      },
      past_due: {
        icon: WarningIcon,
        color: 'warning' as const,
        label: 'Past Due',
        tooltip: 'Payment is past due',
      },
      trialing: {
        icon: ScheduleIcon,
        color: 'primary' as const,
        label: 'Trial',
        tooltip: 'In trial period',
      },
      incomplete: {
        icon: ErrorIcon,
        color: 'danger' as const,
        label: 'Incomplete',
        tooltip: 'Subscription setup incomplete',
      },
      unpaid: {
        icon: ErrorIcon,
        color: 'danger' as const,
        label: 'Unpaid',
        tooltip: 'Payment failed',
      },
    };

    return (
      statusConfig[status as string] || {
        icon: ErrorIcon,
        color: 'neutral' as const,
        label: status || 'Unknown',
        tooltip: `Status: ${status || 'Unknown'}`,
      }
    );
  };

  return { getStatusDisplay };
};

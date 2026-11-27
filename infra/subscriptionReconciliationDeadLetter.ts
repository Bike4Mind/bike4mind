import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const subscriptionReconciliationDlq = runsScheduledJobs
  ? new sst.aws.Queue('subscriptionReconciliationDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const subscriptionReconciliationDeadLetter = subscriptionReconciliationDlq
  ? createEventBusDeadLetter('SubscriptionReconciliation', subscriptionReconciliationDlq)
  : undefined;

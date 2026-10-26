import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// Failed invocations retain the original ScheduledEvent, including the window's event.time.
const youngAccountSpendAlertDlq = runsScheduledJobs
  ? new sst.aws.Queue('youngAccountSpendAlertDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const youngAccountSpendAlertDeadLetter = youngAccountSpendAlertDlq
  ? createEventBusDeadLetter('YoungAccountSpendAlert', youngAccountSpendAlertDlq)
  : undefined;

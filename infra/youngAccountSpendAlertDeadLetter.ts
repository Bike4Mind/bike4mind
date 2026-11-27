import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// One message per failed hour. The body carries the ScheduledEvent's `time` only because the cron
// target in infra/cron.ts clears SST's literal `{}` input; replay steps: infra/signup-code-send-alarm.md.
const youngAccountSpendAlertDlq = runsScheduledJobs
  ? new sst.aws.Queue('youngAccountSpendAlertDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const youngAccountSpendAlertDeadLetter = youngAccountSpendAlertDlq
  ? createEventBusDeadLetter('YoungAccountSpendAlert', youngAccountSpendAlertDlq)
  : undefined;

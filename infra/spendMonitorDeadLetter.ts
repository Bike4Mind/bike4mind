import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// One message per failed 5-minute run. The body carries the ScheduledEvent's `time` only because the cron
// target in infra/cron.ts clears SST's literal `{}` input; a replayed message re-rolls the same buckets.
const spendMonitorDlq = runsScheduledJobs
  ? new sst.aws.Queue('spendMonitorDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const spendMonitorDeadLetter = spendMonitorDlq
  ? createEventBusDeadLetter('SpendMonitor', spendMonitorDlq)
  : undefined;

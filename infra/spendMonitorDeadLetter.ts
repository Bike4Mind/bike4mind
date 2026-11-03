import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// One message per failed 5-minute run. The body carries the ScheduledEvent's `time` only because the cron
// target in infra/cron.ts clears SST's literal `{}` input. A replay only rolls buckets after
// latestBucketStart, so repair already-skipped buckets with `backfill:spend-rollups` instead.
const spendMonitorDlq = runsScheduledJobs
  ? new sst.aws.Queue('spendMonitorDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const spendMonitorDeadLetter = spendMonitorDlq
  ? createEventBusDeadLetter('SpendMonitor', spendMonitorDlq)
  : undefined;

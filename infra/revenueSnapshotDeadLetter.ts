import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const revenueSnapshotDlq = runsScheduledJobs
  ? new sst.aws.Queue('revenueSnapshotDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const revenueSnapshotDeadLetter = revenueSnapshotDlq
  ? createEventBusDeadLetter('RevenueSnapshot', revenueSnapshotDlq)
  : undefined;

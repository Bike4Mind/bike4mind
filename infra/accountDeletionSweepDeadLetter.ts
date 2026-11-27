import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const accountDeletionSweepDlq = runsScheduledJobs
  ? new sst.aws.Queue('accountDeletionSweepDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const accountDeletionSweepDeadLetter = accountDeletionSweepDlq
  ? createEventBusDeadLetter('AccountDeletionSweep', accountDeletionSweepDlq)
  : undefined;

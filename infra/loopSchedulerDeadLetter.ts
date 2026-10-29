import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const loopSchedulerDlq = runsScheduledJobs
  ? new sst.aws.Queue('loopSchedulerDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const loopSchedulerDeadLetter = loopSchedulerDlq
  ? createEventBusDeadLetter('LoopScheduler', loopSchedulerDlq)
  : undefined;

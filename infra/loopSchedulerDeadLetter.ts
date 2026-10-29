import { runsLoopScheduler } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const loopSchedulerDlq = runsLoopScheduler
  ? new sst.aws.Queue('loopSchedulerDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const loopSchedulerDeadLetter = loopSchedulerDlq
  ? createEventBusDeadLetter('LoopScheduler', loopSchedulerDlq)
  : undefined;

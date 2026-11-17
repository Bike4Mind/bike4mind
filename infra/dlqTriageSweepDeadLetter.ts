import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const dlq = runsScheduledJobs
  ? new sst.aws.Queue('dlqTriageSweepDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const dlqTriageSweepDeadLetter = dlq ? createEventBusDeadLetter('DlqTriageSweep', dlq) : undefined;

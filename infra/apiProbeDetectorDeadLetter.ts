import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// One message per failed run. Each run rescans its own window, so a dead-lettered run is
// covered by the overlapping windows of the runs after it; the queue is for the alarm.
const apiProbeDetectorDlq = runsScheduledJobs
  ? new sst.aws.Queue('apiProbeDetectorDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const apiProbeDetectorDeadLetter = apiProbeDetectorDlq
  ? createEventBusDeadLetter('ApiProbeDetector', apiProbeDetectorDlq)
  : undefined;

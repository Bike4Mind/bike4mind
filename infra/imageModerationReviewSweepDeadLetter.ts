import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

// One message per failed 15-minute run; the next run is the retry, so a message is for diagnosis.
const imageModerationReviewSweepDlq = runsScheduledJobs
  ? new sst.aws.Queue('imageModerationReviewSweepDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const imageModerationReviewSweepDeadLetter = imageModerationReviewSweepDlq
  ? createEventBusDeadLetter('ImageModerationReviewSweep', imageModerationReviewSweepDlq)
  : undefined;

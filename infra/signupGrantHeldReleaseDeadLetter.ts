import { runsScheduledJobs } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const signupGrantHeldReleaseDlq = runsScheduledJobs
  ? new sst.aws.Queue('signupGrantHeldReleaseDlq', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

export const signupGrantHeldReleaseDeadLetter = signupGrantHeldReleaseDlq
  ? createEventBusDeadLetter('SignupGrantHeldRelease', signupGrantHeldReleaseDlq)
  : undefined;

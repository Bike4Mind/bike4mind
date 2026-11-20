import { REVIEW_SWEEP_INTERVAL_MINUTES } from '@bike4mind/infra';
import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { eventBus } from './bus';
import { lambdaVpc } from './vpc';
import { imageModerationReviewSweepDeadLetter } from './imageModerationReviewSweepDeadLetter';
import { appFilesBucket } from './buckets';
import { mailBodyEnvironment, mailBodyPutPermission } from './mailBodyOffload';

// Image Moderation Review Sweep - re-sends the reviewer alert for incidents nobody was told about
// and reminds once a day while an incident awaits a verdict. VPC because it reads the incident
// collection. The alarms in infra/imageModerationReviewAlarms.ts watch the metrics it publishes.
const imageModerationReviewSweep =
  runsScheduledJobs && imageModerationReviewSweepDeadLetter
    ? new sst.aws.Cron('imageModerationReviewSweep', {
        schedule: `rate(${REVIEW_SWEEP_INTERVAL_MINUTES} minutes)`,
        function: {
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/imageModerationReviewSweep.handler',
          runtime: 'nodejs24.x',
          timeout: '5 minutes',
          // The next run is the retry; Lambda's async retries would only delay the dead-letter message.
          retries: 0,
          // eventBus: the reviewer alerts and reminders are queued as email.send events.
          link: [...allSecrets, eventBus],
          environment: { ...DEFAULT_LAMBDA_ENVIRONMENT, ...mailBodyEnvironment(appFilesBucket) },
          permissions: [
            mailBodyPutPermission(appFilesBucket),
            imageModerationReviewSweepDeadLetter.sendPermission,
            { actions: ['cloudwatch:PutMetricData'], resources: ['*'] },
          ],
          transform: imageModerationReviewSweepDeadLetter.functionTarget,
          logging: { retention: '1 week' },
        },
        transform: { target: { ...imageModerationReviewSweepDeadLetter.ruleTarget.target, input: undefined } },
      })
    : undefined;

if (imageModerationReviewSweep && imageModerationReviewSweepDeadLetter) {
  imageModerationReviewSweepDeadLetter.allowRules([$util.output(imageModerationReviewSweep)]);
}

import { REVIEW_SWEEP_INTERVAL_MINUTES } from '@bike4mind/infra';
import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { imageModerationReviewSweepDeadLetter } from './imageModerationReviewSweepDeadLetter';

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
          link: [...allSecrets],
          environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
          permissions: [
            imageModerationReviewSweepDeadLetter.sendPermission,
            { actions: ['cloudwatch:PutMetricData'], resources: ['*'] },
          ],
          transform: imageModerationReviewSweepDeadLetter.functionTarget,
          logging: { retention: '1 week' },
        },
        transform: imageModerationReviewSweepDeadLetter.ruleTarget,
      })
    : undefined;

if (imageModerationReviewSweep && imageModerationReviewSweepDeadLetter) {
  imageModerationReviewSweepDeadLetter.allowRules([$util.output(imageModerationReviewSweep)]);
}

import { runsScheduledJobs, DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { createEventBusDeadLetter } from './eventBusDeadLetter';
import { allSecrets } from './secrets';
import { fabFileBucket, generatedImagesBucket } from './buckets';
import { router, routerDistributionId } from './router';

const organizationRetentionDlq = runsScheduledJobs
  ? new sst.aws.Queue('organizationRetentionDlq', { transform: { queue: { messageRetentionSeconds: 1209600 } } })
  : undefined;
export const organizationRetentionDeadLetter = organizationRetentionDlq
  ? createEventBusDeadLetter('OrganizationRetention', organizationRetentionDlq)
  : undefined;

const cron =
  runsScheduledJobs && organizationRetentionDeadLetter
    ? new sst.aws.Cron('organizationRetention', {
        schedule: 'rate(1 hour)',
        function: {
          handler: 'apps/workers/src/cron/organizationRetention.handler',
          runtime: 'nodejs24.x',
          timeout: '3 minutes',
          retries: 0,
          link: [...allSecrets, fabFileBucket, generatedImagesBucket, routerDistributionId],
          environment: DEFAULT_LAMBDA_ENVIRONMENT,
          permissions: [
            organizationRetentionDeadLetter.sendPermission,
            {
              actions: ['cloudfront:CreateInvalidation'],
              resources: [router.nodes.cdn.apply(cdn => cdn.nodes.distribution.arn)],
            },
          ],
          transform: organizationRetentionDeadLetter.functionTarget,
        },
        transform: { target: { ...organizationRetentionDeadLetter.ruleTarget.target, input: undefined } },
      })
    : undefined;
if (cron && organizationRetentionDeadLetter) organizationRetentionDeadLetter.allowRules([$util.output(cron)]);

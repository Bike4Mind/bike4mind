/**
 * Scheduled per-actor API probe detector (apps/workers/src/cron/apiProbeDetector.ts). Lives outside
 * infra/cron.ts because it reads the Next.js server function's log group, and infra/web.ts already
 * imports infra/cron.ts. Hosted only: self-host has no CloudWatch log group to query.
 */
import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { web } from './web';
import { apiProbeDetectorDeadLetter } from './apiProbeDetectorDeadLetter';

const serverLogGroupName = web.nodes.server
  ? web.nodes.server
      .apply(fn => fn.nodes.logGroup)
      .apply(logGroup => {
        if (!logGroup) throw new Error('Next.js server function is missing its CloudWatch log group');
        return logGroup.name;
      })
  : undefined;

// The lookup's arn drops the trailing stream wildcard StartQuery is checked against, so both forms.
const serverLogGroupArn = serverLogGroupName
  ? aws.cloudwatch.getLogGroupOutput({ name: serverLogGroupName }).arn
  : undefined;

export const apiProbeDetector =
  runsScheduledJobs && apiProbeDetectorDeadLetter && serverLogGroupName && serverLogGroupArn
    ? new sst.aws.Cron('apiProbeDetector', {
        schedule: 'rate(5 minutes)',
        enabled: $app.stage === 'production',
        function: {
          // VPC for MongoDB (settings, dedupe claims, account ages).
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/apiProbeDetector.handler',
          runtime: 'nodejs24.x',
          // The next run rescans an overlapping window, so it is the retry.
          retries: 0,
          timeout: '2 minutes',
          link: [...allSecrets],
          environment: {
            ...DEFAULT_LAMBDA_ENVIRONMENT,
            API_SERVER_LOG_GROUP: serverLogGroupName,
          },
          permissions: [
            apiProbeDetectorDeadLetter.sendPermission,
            { actions: ['logs:StartQuery'], resources: [serverLogGroupArn, $interpolate`${serverLogGroupArn}:*`] },
            { actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] },
          ],
          transform: apiProbeDetectorDeadLetter.functionTarget,
          logging: {
            retention: '1 week',
          },
        },
        transform: {
          target: {
            ...apiProbeDetectorDeadLetter.ruleTarget.target,
            // SST defaults to a literal {} input; omit it to retain EventBridge's scheduled time,
            // which the handler's window is anchored to.
            input: undefined,
          },
        },
      })
    : undefined;

if (apiProbeDetector && apiProbeDetectorDeadLetter) {
  apiProbeDetectorDeadLetter.allowRules([$util.output(apiProbeDetector)]);
}

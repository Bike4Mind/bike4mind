import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { lambdaVpc } from './vpc';
import { allSecrets } from './secrets';
import { appUrlForLambdaEnv } from './router';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

const enabled = (process.env.ADMIN_MORNING_BRIEF_ENVIRONMENTS ?? '')
  .split(',')
  .map(stage => stage.trim())
  .includes($app.stage);
const dlq = runsScheduledJobs && enabled ? new sst.aws.Queue('adminMorningBriefDlq', {}) : undefined;
const deadLetter = dlq ? createEventBusDeadLetter('AdminMorningBrief', dlq) : undefined;

export const adminMorningBrief = deadLetter
  ? new sst.aws.Cron('adminMorningBrief', {
      schedule: 'cron(0 8 * * ? *)',
      function: {
        handler: 'apps/workers/src/cron/adminMorningBrief.handler',
        runtime: 'nodejs24.x',
        vpc: lambdaVpc,
        timeout: '3 minutes',
        link: [...allSecrets],
        permissions: [
          deadLetter.sendPermission,
          { actions: ['cloudwatch:DescribeAlarms', 'sqs:GetQueueAttributes'], resources: ['*'] },
        ],
        transform: deadLetter.functionTarget,
        environment: {
          ...DEFAULT_LAMBDA_ENVIRONMENT,
          ADMIN_MORNING_BRIEF_ENABLED: 'true',
          APP_URL: appUrlForLambdaEnv(),
        },
      },
      transform: { target: { ...deadLetter.ruleTarget.target, input: undefined } },
    })
  : undefined;

if (adminMorningBrief && deadLetter) deadLetter.allowRules([$util.output(adminMorningBrief)]);

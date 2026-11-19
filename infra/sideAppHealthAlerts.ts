import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

export const sideAppHealthAlertsDLQ = runsScheduledJobs
  ? new sst.aws.Queue('sideAppHealthAlertsDLQ', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

if (sideAppHealthAlertsDLQ) {
  const deadLetter = createEventBusDeadLetter('sideAppHealthAlertsDLQ', sideAppHealthAlertsDLQ);
  const cron = new sst.aws.Cron('sideAppHealthAlerts', {
    schedule: 'cron(15 * * * ? *)',
    enabled: process.env.SIDE_APP_HEALTH_ALERTS_ENABLED === 'true',
    function: {
      vpc: lambdaVpc,
      handler: 'apps/workers/src/cron/sideAppHealthAlerts.handler',
      runtime: 'nodejs24.x',
      timeout: '5 minutes',
      link: [...allSecrets],
      permissions: [deadLetter.sendPermission],
      transform: deadLetter.functionTarget,
      environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
    },
    transform: deadLetter.ruleTarget,
  });
  deadLetter.allowRules([$util.output(cron)]);
}

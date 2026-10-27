import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

export const businessMetricAlertsDLQ = runsScheduledJobs
  ? new sst.aws.Queue('businessMetricAlertsDLQ', {
      transform: { queue: { messageRetentionSeconds: 1209600 } },
    })
  : undefined;

if (businessMetricAlertsDLQ) {
  const deadLetter = createEventBusDeadLetter('businessMetricAlertsDLQ', businessMetricAlertsDLQ);
  const cron = new sst.aws.Cron('businessMetricAlerts', {
    schedule: 'cron(5 * * * ? *)',
    enabled: process.env.BUSINESS_METRIC_ALERTS_ENABLED !== 'false',
    function: {
      vpc: lambdaVpc,
      handler: 'apps/workers/src/cron/businessMetricAlerts.handler',
      runtime: 'nodejs24.x',
      timeout: '10 minutes',
      link: [...allSecrets],
      permissions: [deadLetter.sendPermission],
      transform: deadLetter.functionTarget,
      environment: {
        ...DEFAULT_LAMBDA_ENVIRONMENT,
        BUSINESS_METRIC_THRESHOLDS: process.env.BUSINESS_METRIC_THRESHOLDS || '{}',
        ANALYTICS_TEST_PATTERN: process.env.ANALYTICS_TEST_PATTERN || '',
      },
    },
    transform: deadLetter.ruleTarget,
  });
  deadLetter.allowRules([$util.output({ nodes: { rule: cron.nodes.rule } })]);
}

import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { createEventBusDeadLetter } from './eventBusDeadLetter';

export let cardVerificationRecoveryDLQ: sst.aws.Queue | undefined;
export let cardVerificationRecoveryLogGroup: $util.Output<string> | undefined;

if (runsScheduledJobs && process.env.CARD_VERIFICATION_RECOVERY_ENABLED === 'true') {
  const queue = new sst.aws.Queue('cardVerificationRecoveryDLQ', {
    transform: { queue: { messageRetentionSeconds: 1209600 } },
  });
  cardVerificationRecoveryDLQ = queue;
  const deadLetter = createEventBusDeadLetter('cardVerificationRecoveryDLQ', queue);
  const cron = new sst.aws.Cron('cardVerificationRecovery', {
    schedule: 'rate(5 minutes)',
    function: {
      handler: 'apps/workers/src/cron/cardVerificationRecovery.handler',
      runtime: 'nodejs24.x',
      timeout: '5 minutes',
      link: [...allSecrets],
      permissions: [deadLetter.sendPermission],
      transform: deadLetter.functionTarget,
      environment: {
        ...DEFAULT_LAMBDA_ENVIRONMENT,
        CARD_VERIFICATION_DEFENSE_POLICY: process.env.CARD_VERIFICATION_DEFENSE_POLICY || '',
        CARD_VERIFICATION_RECOVERY_ENABLED: 'true',
        APP_URL: process.env.APP_URL || '',
      },
    },
    transform: deadLetter.ruleTarget,
  });
  deadLetter.allowRules([$util.output({ nodes: { rule: cron.nodes.rule } })]);
  cardVerificationRecoveryLogGroup = cron.nodes.function
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('Card verification recovery requires a CloudWatch log group');
      return logGroup.name;
    });
}

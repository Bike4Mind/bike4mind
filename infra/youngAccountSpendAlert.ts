/**
 * Young-account spend alert: an hourly job that names the accounts behind young-account spend and
 * applies the admin-setting threshold overrides to the page and warn alarms from infra/llmSpend.ts.
 *
 * Lives beside the alarms rather than in infra/cron.ts because it depends on them: llmSpend.ts
 * reaches infra/web.ts (through dlqAlarms.ts and llmSpendLogGroups.ts), and web.ts imports
 * functions from cron.ts, so cron.ts must never import llmSpend.ts.
 * Guarded by infra/__tests__/infraImportCycles.test.ts.
 */
import { DEFAULT_LAMBDA_ENVIRONMENT, runsScheduledJobs } from './constants';
import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { alarmSlackMentionFunctionArgs } from './alarmSlackMention';
import { youngAccountSpendAlertDeadLetter } from './youngAccountSpendAlertDeadLetter';
import { youngAccountSpendAlarms } from './llmSpend';

const youngAccountSpendAlertMention = alarmSlackMentionFunctionArgs();
// The job rewrites these two alarms' thresholds from admin settings (youngAccountSpendAlarmThresholds.ts).
const [youngAccountSpendPageAlarm, youngAccountSpendWarnAlarm] = youngAccountSpendAlarms;
const youngAccountSpendAlarmArgs =
  youngAccountSpendPageAlarm && youngAccountSpendWarnAlarm
    ? {
        environment: {
          YOUNG_ACCOUNT_SPEND_ALARM_NAME: youngAccountSpendPageAlarm.name,
          YOUNG_ACCOUNT_SPEND_WARN_ALARM_NAME: youngAccountSpendWarnAlarm.name,
        },
        permissions: [
          {
            actions: ['cloudwatch:DescribeAlarms', 'cloudwatch:PutMetricAlarm'],
            resources: youngAccountSpendAlarms.map(alarm => alarm.arn),
          },
        ],
      }
    : { environment: { YOUNG_ACCOUNT_SPEND_ALARM_NAME: '', YOUNG_ACCOUNT_SPEND_WARN_ALARM_NAME: '' }, permissions: [] };
const youngAccountSpendAlert =
  runsScheduledJobs && youngAccountSpendAlertDeadLetter
    ? new sst.aws.Cron('youngAccountSpendAlert', {
        schedule: 'rate(1 hour)',
        enabled: $app.stage === 'production',
        function: {
          vpc: lambdaVpc,
          handler: 'apps/workers/src/cron/youngAccountSpendAlert.handler',
          runtime: 'nodejs24.x',
          timeout: '2 minutes',
          link: [...allSecrets],
          environment: {
            ...DEFAULT_LAMBDA_ENVIRONMENT,
            YOUNG_ACCOUNT_SPEND_ALERT_CREDITS: process.env.YOUNG_ACCOUNT_SPEND_ALERT_CREDITS || '',
            YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS: process.env.YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS || '',
            ...youngAccountSpendAlarmArgs.environment,
            ...youngAccountSpendAlertMention.environment,
          },
          permissions: [
            youngAccountSpendAlertDeadLetter.sendPermission,
            ...youngAccountSpendAlertMention.permissions,
            ...youngAccountSpendAlarmArgs.permissions,
          ],
          transform: youngAccountSpendAlertDeadLetter.functionTarget,
          logging: {
            retention: '1 week',
          },
        },
        transform: {
          target: {
            ...youngAccountSpendAlertDeadLetter.ruleTarget.target,
            // SST defaults to a literal {} input; omit it to retain EventBridge's scheduled time.
            // The handler's window, its DLQ message body and replay all depend on it.
            input: undefined,
          },
        },
      })
    : undefined;

if (youngAccountSpendAlert && youngAccountSpendAlertDeadLetter) {
  youngAccountSpendAlertDeadLetter.allowRules([$util.output(youngAccountSpendAlert)]);
}

export { youngAccountSpendAlert };

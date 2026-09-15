import { allSecrets } from './secrets';
import { lambdaVpc } from './vpc';
import { eventBus } from './bus';

/**
 * SNS Topic for Security Alerts (optional - can be used for admin notifications)
 * Note: User-specific alerts are sent directly via EventBridge + mailer
 */
export const SecurityAlertsTopic = new sst.aws.SnsTopic('SecurityAlerts', {});

/**
 * CloudWatch Events Schedule for Security Alerts
 * Runs every 5 minutes to check for suspicious patterns
 * Sends emails directly to users via EventBridge + mailer (same as rest of codebase)
 */
export const SecurityAlertsSchedule = new sst.aws.Cron('SecurityAlertsSchedule', {
  schedule: 'rate(5 minutes)', // Check every 5 minutes
  job: {
    vpc: lambdaVpc,
    handler: 'apps/client/server/security/alertProcessor.handler',
    runtime: 'nodejs24.x',
    link: [eventBus, ...allSecrets],
    permissions: [
      {
        actions: ['events:PutEvents'],
        resources: [eventBus.arn],
      },
    ],
  },
  enabled: ['production', 'dev'].includes($app.stage),
});

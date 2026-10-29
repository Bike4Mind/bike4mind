/**
 * Aggregate alarm for refused OAuth sign-ups. One log line per refusal becomes one metric, so a
 * burst reads as a single 5-minute signal instead of one Slack page per attempt.
 *
 * Emitted by: apps/client/pages/api/auth/[strategy]/callback.ts (`oauth-signup-refused`, info level).
 * Stage-gated like alarms.ts: `dev` and `production`, or ENABLE_MONITORING=true.
 */
import { dlqAlarmTopic } from './dlqAlarms';
import { web } from './web';
import { oauthSignupsRefusedMetricName } from './authAbuseMetric';
import { messageFilterPattern } from './logMessageFilterPattern';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const NAMESPACE = 'Lumina5/AuthSecurity';
const METRIC_NAME = oauthSignupsRefusedMetricName($app.stage);
const DEFAULT_THRESHOLD_PER_5MIN = 25;

const threshold = Number(process.env.OAUTH_SIGNUP_REFUSED_ALARM_PER_5MIN) || DEFAULT_THRESHOLD_PER_5MIN;

export const oauthSignupsRefusedAlarm =
  isMonitoredStage && web.nodes.server
    ? (() => {
        // Same stage gate as dlqAlarms.ts; narrows the conditional export without a non-null assertion.
        if (!dlqAlarmTopic) {
          throw new Error('alarm routing requires dlqAlarmTopic');
        }

        new aws.cloudwatch.LogMetricFilter('oauthSignupsRefusedFilter', {
          name: `${$app.name}-${$app.stage}-oauth-signups-refused`,
          logGroupName: web.nodes.server.nodes.logGroup.apply(lg => {
            if (!lg) throw new Error('server function is missing its CloudWatch log group');
            return lg.name;
          }),
          // The server Lambda keeps the default text format (`ts\treqId\tLEVEL\t{json}`), so a JSON `{ $.field = ... }`
          // selector never matches; match the message key and value inside the line instead.
          pattern: messageFilterPattern('oauth-signup-refused'),
          metricTransformation: {
            name: METRIC_NAME,
            namespace: NAMESPACE,
            value: '1',
            unit: 'Count',
          },
        });

        return new aws.cloudwatch.MetricAlarm('oauthSignupsRefusedBurst', {
          name: `${$app.name}-${$app.stage}-oauth-signups-refused-burst`,
          alarmDescription: `Burst of refused OAuth sign-ups (>=${threshold} in 5 min) - likely a sign-up abuse wave against a closed registration`,
          comparisonOperator: 'GreaterThanOrEqualToThreshold',
          evaluationPeriods: 1,
          metricName: METRIC_NAME,
          namespace: NAMESPACE,
          period: 300, // 5 minutes
          statistic: 'Sum',
          threshold,
          treatMissingData: 'notBreaching',
          alarmActions: [dlqAlarmTopic.arn],
          okActions: [dlqAlarmTopic.arn],
          tags: {
            Application: 'Auth',
            Severity: 'Warning',
          },
        });
      })()
    : undefined;

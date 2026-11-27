/**
 * Alerts when one client IP collects a burst of refused, signed-out API requests in 15 minutes.
 * Alerting only: nothing here blocks a caller. A volume-only complement to the API probe detector
 * (apps/workers/src/cron/apiProbeDetector.ts), which scores what was probed.
 *
 * Source: the server function's `req-timing` lines, counted per IP by a Contributor Insights rule
 * (infra/refusedRequestRules.ts). The relay (apps/workers/src/events/refusedRequestBurstDetail.ts)
 * names the top IPs, the top IP's paths and any account that signed up from it.
 * Stage-gated like alarms.ts: `dev` and `production`, or ENABLE_MONITORING=true. Hosted only:
 * self-host has no CloudWatch log group to evaluate.
 */
import { dlqAlarmTopic } from './dlqAlarms';
import { web } from './web';
import {
  DEFAULT_REFUSED_REQUEST_THRESHOLD_PER_15MIN,
  REFUSED_REQUEST_WINDOW_SECONDS,
  refusedRequestRuleDefinition,
  refusedRequestRuleName,
  type RefusedRequestRuleKind,
} from './refusedRequestRules';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const threshold =
  Number(process.env.REFUSED_REQUEST_BURST_ALARM_PER_15MIN) || DEFAULT_REFUSED_REQUEST_THRESHOLD_PER_15MIN;

export const refusedRequestBurstAlarm =
  isMonitoredStage && web.nodes.server
    ? (() => {
        // Same stage gate as dlqAlarms.ts; narrows the conditional export without a non-null assertion.
        if (!dlqAlarmTopic) {
          throw new Error('alarm routing requires dlqAlarmTopic');
        }
        const logGroupName = web.nodes.server.nodes.logGroup.apply(lg => {
          if (!lg) throw new Error('server function is missing its CloudWatch log group');
          return lg.name;
        });
        const rule = (resourceName: string, kind: RefusedRequestRuleKind) =>
          new aws.cloudwatch.ContributorInsightRule(resourceName, {
            ruleName: refusedRequestRuleName($app.name, $app.stage, kind),
            ruleState: 'ENABLED',
            ruleDefinition: logGroupName.apply(name => refusedRequestRuleDefinition(name, kind)),
          });

        const byIp = rule('refusedRequestsByIp', 'by-ip');
        rule('refusedRequestsByIpPath', 'by-ip-path');

        return new aws.cloudwatch.MetricAlarm('refusedRequestBurst', {
          name: `${$app.name}-${$app.stage}-refused-request-burst`,
          alarmDescription: `One client IP sent >=${threshold} refused, signed-out API requests in 15 min`,
          comparisonOperator: 'GreaterThanOrEqualToThreshold',
          evaluationPeriods: 1,
          threshold,
          treatMissingData: 'notBreaching',
          metricQueries: [
            {
              id: 'topIp',
              returnData: true,
              expression: $interpolate`INSIGHT_RULE_METRIC('${byIp.ruleName}', 'MaxContributorValue')`,
              period: REFUSED_REQUEST_WINDOW_SECONDS,
              label: 'Refused signed-out requests from the top IP',
            },
          ],
          alarmActions: [dlqAlarmTopic.arn],
          okActions: [dlqAlarmTopic.arn],
          tags: {
            Application: 'Auth',
            Severity: 'Warning',
          },
        });
      })()
    : undefined;

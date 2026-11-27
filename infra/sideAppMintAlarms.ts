/**
 * Backstop for connected-app health, independent of the hourly cron: a sustained rate of our-fault
 * refusals on the token mint route. It covers mint 5xx while Mongo is up. A Mongo outage is covered
 * by the cron's dead-letter alarm. The event line is emitted beside logOAuthError in
 * apps/client/server/auth/oauthErrorLog.ts.
 */

import { web } from './web';
import { dlqAlarmTopic } from './dlqAlarms';
import { messageFilterPattern } from './logMessageFilterPattern';
import { SIDE_APP_MINT_OUR_FAULT_EVENT } from '../packages/server-utils/src/auth/sideAppMintEvent';
import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

// One failed mint is noise; a handful per 5 minutes for 15 minutes running is an outage.
const SIDE_APP_MINT_OUR_FAULT_PER_5MIN = 5;
const SIDE_APP_MINT_OUR_FAULT_PERIODS = 3;

if (isMonitoredStage) {
  if (!dlqAlarmTopic) {
    throw new Error('alarm routing requires dlqAlarmTopic');
  }

  if (!web.nodes.server) {
    throw new Error('side app mint alarm requires the Next.js server function');
  }

  const serverLogGroupName = web.nodes.server
    .apply(fn => fn.nodes.logGroup)
    .apply(logGroup => {
      if (!logGroup) throw new Error('Next.js server function is missing its CloudWatch log group');
      return logGroup.name;
    });

  const namespace = `${$app.name}/${$app.stage}/SideApps`;

  new aws.cloudwatch.LogMetricFilter('sideAppMintOurFaultFilter', {
    name: `${$app.name}-${$app.stage}-side-app-mint-our-fault`,
    logGroupName: serverLogGroupName,
    pattern: messageFilterPattern(SIDE_APP_MINT_OUR_FAULT_EVENT),
    metricTransformation: {
      name: 'SideAppMintOurFault',
      namespace,
      value: '1',
      unit: 'Count',
    },
  });

  // Slack only (dlqAlarmTopic). OK actions close each episode so the next breach notifies again.
  new aws.cloudwatch.MetricAlarm('sideAppMintOurFault', {
    name: `${$app.name}-${$app.stage}-side-app-mint-our-fault`,
    alarmDescription:
      'Connected app token exchanges are failing on our side at a sustained rate: 5 or more per 5 minutes for 15 minutes',
    comparisonOperator: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: SIDE_APP_MINT_OUR_FAULT_PERIODS,
    datapointsToAlarm: SIDE_APP_MINT_OUR_FAULT_PERIODS,
    metricName: 'SideAppMintOurFault',
    namespace,
    period: 300,
    statistic: 'Sum',
    threshold: SIDE_APP_MINT_OUR_FAULT_PER_5MIN,
    treatMissingData: 'notBreaching',
    alarmActions: [dlqAlarmTopic.arn],
    okActions: [dlqAlarmTopic.arn],
    tags: { Application: 'SideApps', Severity: 'High' },
  });
}

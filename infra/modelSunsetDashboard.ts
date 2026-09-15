/**
 * CloudWatch Dashboard for model sunset (deprecated-model usage)
 *
 * Answers one question without grepping logs: are requests still arriving pinned
 * to a deprecated model, and which model is it? The resolver upgrades those pins
 * silently, so the count of them is the only evidence they exist.
 *
 * Metric emitted by: b4m-core/llm-adapters/src/modelSunsetMetrics.ts
 * Alarm: `deprecatedModelRequest` in alarms.ts (Stage-only dimension set).
 *
 * Stage-gated the same way as alarms.ts / dashboard.ts.
 */

import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const NAMESPACE = 'Lumina5/ModelSunset';
const METRIC = 'DeprecatedModelRequest';

let modelSunsetDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  const dashboardBody = $util
    .all([aws.getRegionOutput().name, aws.getCallerIdentityOutput().accountId])
    .apply(([region, accountId]) =>
      JSON.stringify({
        widgets: [
          {
            type: 'alarm',
            x: 0,
            y: 0,
            width: 24,
            height: 3,
            properties: {
              title: 'Model Sunset - Alarm Status',
              alarms: [
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-deprecated-model-request`,
              ],
            },
          },
          {
            type: 'metric',
            x: 0,
            y: 3,
            width: 18,
            height: 6,
            properties: {
              title: 'Requests by Deprecated Model',
              // SEARCH picks up new model ids automatically, so a newly deprecated
              // model shows up here without a dashboard edit.
              metrics: [
                [
                  {
                    expression: `SEARCH('{${NAMESPACE},Model,Stage} MetricName="${METRIC}" Stage="${$app.stage}"', 'Sum', 300)`,
                    id: 'by_model',
                  },
                ],
              ],
              view: 'timeSeries',
              stacked: true,
              region,
              period: 300,
              yAxis: { left: { min: 0, label: 'Requests' } },
            },
          },
          {
            type: 'metric',
            x: 18,
            y: 3,
            width: 6,
            height: 6,
            properties: {
              title: 'Deprecated-Model Requests (24h)',
              metrics: [[NAMESPACE, METRIC, 'Stage', $app.stage, { stat: 'Sum', label: 'Total' }]],
              view: 'singleValue',
              region,
              period: 86400,
            },
          },
        ],
      })
    );

  modelSunsetDashboard = new aws.cloudwatch.Dashboard('ModelSunsetDashboard', {
    dashboardName: `${$app.name}-${$app.stage}-model-sunset`,
    dashboardBody,
  });
}

export { modelSunsetDashboard };

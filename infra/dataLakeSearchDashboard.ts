/**
 * CloudWatch Dashboard for data-lake semantic search retrieval.
 *
 * Answers one question without grepping logs: is the ANN index actually serving
 * searches, or has the path silently fallen back to brute-force scanning? The
 * failure mode is quiet - results still come back, they just cost a full scan -
 * so the two counters have to be read against each other rather than alone.
 *
 * Metrics emitted by: b4m-core/services/src/dataLakeService/dataLakeSearchMetrics.ts
 * No alarm yet: ChunksScanned is the regression signal, but its threshold is
 * corpus- and traffic-dependent and there is no production baseline while the
 * vector-search flag is still off.
 *
 * Stage-gated the same way as alarms.ts / dashboard.ts.
 */

import { isMonitoredStage as _isMonitoredStage } from '@bike4mind/infra';

const MONITORED_STAGES = ['dev', 'production'] as const;
const isMonitoredStage = _isMonitoredStage($app.stage, MONITORED_STAGES, process.env.ENABLE_MONITORING);

const NAMESPACE = 'Lumina5/DataLakeSearch';

let dataLakeSearchDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  const dashboardBody = aws.getRegionOutput().name.apply(region =>
    JSON.stringify({
      widgets: [
        {
          type: 'metric',
          x: 0,
          y: 0,
          width: 18,
          height: 6,
          properties: {
            // The cutover read in one glance. These are the same searches counted two ways, so
            // the shape that matters is the crossover: files the index kept off the scan path
            // rising while scanned chunks fall toward zero. Scanned chunks turning back up is
            // the regression.
            title: 'ANN Coverage vs Brute-Force Scanning',
            metrics: [
              [
                NAMESPACE,
                'AnnUnrankedFilesLeftOffScan',
                'Stage',
                $app.stage,
                { stat: 'Sum', label: 'Files left off scan (ANN saturated)' },
              ],
              [
                NAMESPACE,
                'ChunksScanned',
                'Stage',
                $app.stage,
                { stat: 'Sum', label: 'Chunks scanned', yAxis: 'right' },
              ],
            ],
            view: 'timeSeries',
            region,
            period: 300,
            // Separate axes on purpose: chunks outnumber files by orders of magnitude, and on a
            // shared axis the file series flattens into the baseline and stops being readable.
            yAxis: { left: { min: 0, label: 'Files' }, right: { min: 0, label: 'Chunks' } },
          },
        },
        {
          type: 'metric',
          x: 18,
          y: 0,
          width: 6,
          height: 6,
          properties: {
            title: 'Chunks Scanned (24h)',
            metrics: [[NAMESPACE, 'ChunksScanned', 'Stage', $app.stage, { stat: 'Sum', label: 'Total' }]],
            view: 'singleValue',
            region,
            period: 86400,
          },
        },
        {
          type: 'metric',
          x: 0,
          y: 6,
          width: 12,
          height: 6,
          properties: {
            // Split by backend: Atlas and self-host OpenSearch take different paths through the
            // saturation rebucket, so a combined line hides which one changed.
            title: 'ANN Hits by Backend',
            metrics: [
              [
                {
                  expression: `SEARCH('{${NAMESPACE},Backend,Stage} MetricName="AnnHits" Stage="${$app.stage}"', 'Sum', 300)`,
                  id: 'ann_hits',
                },
              ],
            ],
            view: 'timeSeries',
            region,
            period: 300,
            yAxis: { left: { min: 0, label: 'Hits' } },
          },
        },
        {
          type: 'metric',
          x: 12,
          y: 6,
          width: 12,
          height: 6,
          properties: {
            // Cap pressure on MAX_ALTERNATE_ANN_MODELS: Maximum, not Sum, because the question is
            // whether any single search hit the cap, which a total across searches cannot answer.
            title: 'Embedding Models Queried per Search',
            metrics: [
              [NAMESPACE, 'AnnModelsQueried', 'Stage', $app.stage, { stat: 'Maximum', label: 'Max' }],
              [NAMESPACE, 'AnnModelsQueried', 'Stage', $app.stage, { stat: 'Average', label: 'Average' }],
            ],
            view: 'timeSeries',
            region,
            period: 300,
            yAxis: { left: { min: 0, label: 'Models' } },
          },
        },
      ],
    })
  );

  dataLakeSearchDashboard = new aws.cloudwatch.Dashboard('DataLakeSearchDashboard', {
    dashboardName: `${$app.name}-${$app.stage}-data-lake-search`,
    dashboardBody,
  });
}

export { dataLakeSearchDashboard };

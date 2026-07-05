/**
 * CloudWatch Dashboard for What's New Modal Generation
 *
 * Provides operational visibility with 7 rows of widgets:
 * - Row 0: Alarm Status (quick view of all 5 alarms)
 * - Row 1: Success Rate + Generation Volume
 * - Row 2: Processing Duration + Lambda Performance
 * - Row 3: Token Usage + Cost Tracking
 * - Row 4: Queue Health (depth + processing rate)
 * - Row 5: Recent Errors (CloudWatch Logs Insights query)
 * - Row 6: 24-Hour Summary Statistics
 *
 * Stage-gated: Only deployed to `dev` and `production` stages.
 * Set ENABLE_MONITORING=true to opt in for other stages.
 *
 * IMPORTANT: Log query format
 * - Use \n| to separate query commands (NOT \\n|)
 * - JSON.stringify() handles escaping automatically
 * - Always add time filter to limit scan scope
 *
 * @see docs/whats-new-automation.md for operational procedures
 */

import { whatsNewGenerationQueueSubscription, whatsNewGenerationQueue, whatsNewGenerationQueueDLQ } from './queues';

const MONITORED_STAGES = ['dev', 'production'];
const isMonitoredStage = MONITORED_STAGES.includes($app.stage) || process.env.ENABLE_MONITORING === 'true';

let whatsNewDashboard: aws.cloudwatch.Dashboard | undefined;

if (isMonitoredStage) {
  /**
   * Dashboard body with Pulumi Outputs properly handled
   *
   * Using $util.all().apply() pattern (same as logMonitor.ts) to resolve
   * dynamic resource names at deployment time. This ensures the dashboard
   * works reliably across all deployments including forks.
   */
  const dashboardBody = $util
    .all([
      whatsNewGenerationQueueSubscription.nodes.function.name,
      whatsNewGenerationQueue.nodes.queue.name,
      whatsNewGenerationQueueDLQ.nodes.queue.name,
      aws.getRegionOutput().name,
      aws.getCallerIdentityOutput().accountId,
    ])
    .apply(([functionName, queueName, dlqName, region, accountId]) => {
      return JSON.stringify({
        widgets: [
          // Row 0: Alarm Status Widget (y=0, full width)
          {
            type: 'alarm',
            x: 0,
            y: 0,
            width: 24,
            height: 3,
            properties: {
              title: "What's New Generation - Alarm Status",
              alarms: [
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-whats-new-high-failures`,
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-whats-new-long-duration`,
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-whats-new-high-cost`,
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-whats-new-lambda-errors`,
                `arn:aws:cloudwatch:${region}:${accountId}:alarm:${$app.name}-${$app.stage}-whats-new-dlq-messages`,
              ],
            },
          },

          // Row 1: Success Rate and Volume (y=3)
          {
            type: 'metric',
            x: 0,
            y: 3,
            width: 12,
            height: 6,
            properties: {
              title: 'Generation Success Rate',
              metrics: [
                [
                  {
                    expression: '(successes / (successes + failures)) * 100',
                    label: 'Success Rate (%)',
                    id: 'success_rate',
                  },
                ],
                ['Lumina5/ModalGeneration', 'Success', { id: 'successes', visible: false, stat: 'Sum' }],
                ['.', 'Failure', { id: 'failures', visible: false, stat: 'Sum' }],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
              yAxis: {
                left: {
                  min: 0,
                  max: 100,
                },
              },
              annotations: {
                horizontal: [
                  {
                    value: 95,
                    label: 'Target: 95%',
                    fill: 'above',
                  },
                ],
              },
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 3,
            width: 12,
            height: 6,
            properties: {
              title: 'Generation Volume',
              metrics: [
                ['Lumina5/ModalGeneration', 'Success', { stat: 'Sum', label: 'Successful', color: '#2ca02c' }],
                ['.', 'Failure', { stat: 'Sum', label: 'Failed', color: '#d62728' }],
                ['.', 'Skipped', { stat: 'Sum', label: 'Skipped (Synced)', color: '#ff7f0e' }],
              ],
              view: 'timeSeries',
              stacked: true,
              region: region,
              period: 300,
              yAxis: {
                left: {
                  min: 0,
                },
              },
            },
          },

          // Row 2: Duration and Performance (y=9)
          {
            type: 'metric',
            x: 0,
            y: 9,
            width: 12,
            height: 6,
            properties: {
              title: 'Processing Duration',
              metrics: [
                ['Lumina5/ModalGeneration', 'Duration', { stat: 'Average', label: 'Average' }],
                ['...', { stat: 'Maximum', label: 'Maximum' }],
                ['...', { stat: 'Minimum', label: 'Minimum' }],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
              yAxis: {
                left: {
                  label: 'Milliseconds',
                },
              },
              annotations: {
                horizontal: [
                  {
                    value: 120000,
                    label: 'Timeout Threshold: 2 min',
                    fill: 'above',
                  },
                ],
              },
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 9,
            width: 12,
            height: 6,
            properties: {
              title: 'Lambda Function Performance',
              metrics: [
                ['AWS/Lambda', 'Duration', 'FunctionName', functionName, { stat: 'Average', label: 'Avg Duration' }],
                [
                  'AWS/Lambda',
                  'Errors',
                  'FunctionName',
                  functionName,
                  { stat: 'Sum', label: 'Errors', yAxis: 'right' },
                ],
                [
                  'AWS/Lambda',
                  'Throttles',
                  'FunctionName',
                  functionName,
                  { stat: 'Sum', label: 'Throttles', yAxis: 'right' },
                ],
                [
                  'AWS/Lambda',
                  'ConcurrentExecutions',
                  'FunctionName',
                  functionName,
                  { stat: 'Maximum', label: 'Max Concurrency', yAxis: 'right' },
                ],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
            },
          },

          // Row 3: Costs and Token Usage (y=15)
          {
            type: 'metric',
            x: 0,
            y: 15,
            width: 12,
            height: 6,
            properties: {
              title: 'Token Usage',
              metrics: [
                ['Lumina5/ModalGeneration', 'TokensUsed', { stat: 'Average', label: 'Avg Tokens' }],
                ['...', { stat: 'Sum', label: 'Total Tokens', yAxis: 'right' }],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 15,
            width: 12,
            height: 6,
            properties: {
              title: 'Estimated Costs',
              metrics: [
                ['Lumina5/ModalGeneration', 'EstimatedCost', { stat: 'Sum', label: 'Total Cost' }],
                ['...', { stat: 'Average', label: 'Avg Cost per Generation' }],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
              yAxis: {
                left: {
                  label: 'USD ($)',
                },
              },
              annotations: {
                horizontal: [
                  {
                    value: 0.05,
                    label: 'Cost Threshold: $0.05',
                    fill: 'above',
                  },
                ],
              },
            },
          },

          // Row 4: Queue Health (y=21)
          {
            type: 'metric',
            x: 0,
            y: 21,
            width: 12,
            height: 6,
            properties: {
              title: 'Queue Depth',
              metrics: [
                [
                  'AWS/SQS',
                  'ApproximateNumberOfMessagesVisible',
                  'QueueName',
                  queueName,
                  { stat: 'Average', label: 'Messages in Queue' },
                ],
                [
                  'AWS/SQS',
                  'ApproximateNumberOfMessagesVisible',
                  'QueueName',
                  dlqName,
                  { stat: 'Maximum', label: 'DLQ Messages', color: '#d62728' },
                ],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 60,
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 21,
            width: 12,
            height: 6,
            properties: {
              title: 'Queue Processing Rate',
              metrics: [
                ['AWS/SQS', 'NumberOfMessagesSent', 'QueueName', queueName, { stat: 'Sum', label: 'Sent' }],
                ['AWS/SQS', 'NumberOfMessagesDeleted', 'QueueName', queueName, { stat: 'Sum', label: 'Processed' }],
              ],
              view: 'timeSeries',
              stacked: false,
              region: region,
              period: 300,
            },
          },

          // Row 5: Error Details (CloudWatch Logs Insights) (y=27)
          {
            type: 'log',
            x: 0,
            y: 27,
            width: 24,
            height: 6,
            properties: {
              // IMPORTANT: Query format uses \n| for line separation
              // The \n in the JavaScript string becomes \\n in JSON automatically via JSON.stringify()
              // Always include time filter to limit scan scope and reduce costs
              query: `SOURCE '/aws/lambda/${functionName}'\n| fields @timestamp, @message, correlationId\n| filter @timestamp > ago(1h)\n| filter severity = "error" or @message like /ERROR/\n| sort @timestamp desc\n| limit 20`,
              region: region,
              title: 'Recent Errors (Last Hour)',
              view: 'table',
            },
          },

          // Row 6: Summary Stats (y=33)
          {
            type: 'metric',
            x: 0,
            y: 33,
            width: 6,
            height: 3,
            properties: {
              metrics: [['Lumina5/ModalGeneration', 'Success', { stat: 'Sum', label: 'Total Successful' }]],
              view: 'singleValue',
              region: region,
              period: 86400, // 24 hours
              title: 'Successful (24h)',
            },
          },
          {
            type: 'metric',
            x: 6,
            y: 33,
            width: 6,
            height: 3,
            properties: {
              metrics: [['Lumina5/ModalGeneration', 'Failure', { stat: 'Sum', label: 'Total Failures' }]],
              view: 'singleValue',
              region: region,
              period: 86400,
              title: 'Failures (24h)',
            },
          },
          {
            type: 'metric',
            x: 12,
            y: 33,
            width: 6,
            height: 3,
            properties: {
              metrics: [['Lumina5/ModalGeneration', 'EstimatedCost', { stat: 'Sum', label: 'Total Cost' }]],
              view: 'singleValue',
              region: region,
              period: 86400,
              title: 'Total Cost (24h)',
            },
          },
          {
            type: 'metric',
            x: 18,
            y: 33,
            width: 6,
            height: 3,
            properties: {
              metrics: [['Lumina5/ModalGeneration', 'TokensUsed', { stat: 'Sum', label: 'Total Tokens' }]],
              view: 'singleValue',
              region: region,
              period: 86400,
              title: 'Tokens Used (24h)',
            },
          },
        ],
      });
    });

  whatsNewDashboard = new aws.cloudwatch.Dashboard('WhatsNewGenerationDashboard', {
    dashboardName: `${$app.name}-${$app.stage}-whats-new-generation`,
    dashboardBody: dashboardBody,
  });
}

export { whatsNewDashboard };

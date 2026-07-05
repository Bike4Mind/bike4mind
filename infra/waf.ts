/**
 * SST-managed WAF.
 *
 * Creates a CloudFront-scope WAFv2 WebACL in us-east-1 and exposes its ARN for
 * association to the Router CloudFront distribution.
 *
 * Controlled by ENABLE_WAF environment variable (default: false).
 * For PR testing, temporarily set ENABLE_WAF=true (don't forget to unset before merging).
 */

import { buildDevWafRuleJson, getDevWafMeta } from './wafPolicy';
import { secrets } from './secrets';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';

// WAF is disabled by default. Enable via ENABLE_WAF=true environment variable.
// For production and dev, set ENABLE_WAF=true in GitHub Variables.
const isWafEnabled = process.env.ENABLE_WAF === 'true';

// CloudFront-scope WAF resources must be created in us-east-1.
const wafProviderUsEast1 = isWafEnabled
  ? new aws.Provider('waf-us-east-1', {
      region: 'us-east-1',
    })
  : undefined;

/**
 * Emergency IP block set.
 *
 * WAF requires at least one address in the IPSet. Use a TEST-NET IP that should never appear in real traffic.
 */
export const wafEmergencyIpSet = isWafEnabled
  ? new aws.wafv2.IpSet(
      'WafEmergencyIpBlockSet',
      {
        // Use stage-specific naming for ALL stages to avoid conflicts
        name: $app.stage === 'production' ? 'emergency-ip-block-prod' : `emergency-ip-block-${$app.stage}`,
        // WAF description regex does not allow parentheses.
        description: `Emergency IP block list - ${$app.stage}`,
        scope: 'CLOUDFRONT',
        ipAddressVersion: 'IPV4',
        addresses: ['192.0.2.0/32'],
      },
      {
        provider: wafProviderUsEast1,
        // Retain IPSet for permanent stages only — PR stages are torn down and recreated,
        // so retaining would orphan the resource and cause WAFDuplicateItemException on redeploy.
        retainOnDelete: ['production', 'dev'].includes($app.stage),
      }
    )
  : undefined;

/**
 * CloudWatch Logs group for WAF traffic logs.
 *
 * CRITICAL: Log group name MUST start with 'aws-waf-logs-' prefix because:
 * 1. IAM permissions in infra/web.ts are scoped to this prefix (line 152)
 * 2. AWS WAF service role requires this naming convention
 * 3. Backend queries (wafLogsInsights.ts) expect this prefix for discovery
 *
 * Logs contain JSON-formatted WAF evaluation results with all fields required by the 4 graphs:
 * - httpRequest.country (Graph 2: Top Countries)
 * - labels[].name (Graphs 1 & 3: Attack Types, Managed Rule Labels)
 * - action, terminatingRuleId, terminatingRuleType (Graph 4: Terminated Requests)
 * - @timestamp (all time-series graphs)
 *
 * Retention strategy:
 * - Production: 90 days (compliance, audit trails, long-term incident investigation)
 * - Dev/PR: 30 days (cost optimization, sufficient for debugging and testing)
 */
export const wafLogGroup = isWafEnabled
  ? new aws.cloudwatch.LogGroup(
      'WafLogGroup',
      {
        // CRITICAL: MUST start with 'aws-waf-logs-' (see comment above)
        name: `aws-waf-logs-bike4mind-${$app.stage}`,
        // Retention: 90 days for production, 30 days for dev/PR stages
        retentionInDays: $app.stage === 'production' ? 90 : 30,
      },
      {
        // MUST be us-east-1 for CloudFront-scope WAF
        provider: wafProviderUsEast1,
        // Retain logs for dev/production stages (safety net), auto-delete for PR stages (cleanup)
        retainOnDelete: $app.stage === 'dev' || $app.stage === 'production',
      }
    )
  : undefined;

/**
 * WebACL built from the exported policy.
 */
export const wafWebAcl = isWafEnabled
  ? new aws.wafv2.WebAcl(
      'WafWebAcl',
      (() => {
        // Use stage-specific suffix for ALL stages (not just production)
        // This ensures each stage gets its own WebACL (e.g., bike4mind-api-protection-pr6391)
        const stageSuffix = $app.stage === 'production' ? 'prod' : $app.stage;
        const policy = getDevWafMeta({ nameSuffix: stageSuffix, stage: $app.stage });

        const ruleJson = wafEmergencyIpSet!.arn.apply(arn =>
          buildDevWafRuleJson({ emergencyIpSetArn: arn, stage: $app.stage })
        );

        return {
          name: policy.name,
          description: policy.description,
          scope: policy.scope,
          defaultAction: policy.defaultAction,
          ruleJson,
          visibilityConfig: policy.visibilityConfig,
        };
      })(),
      {
        provider: wafProviderUsEast1,
        // Retain WebACL for permanent stages only — same reasoning as IPSet above.
        retainOnDelete: ['production', 'dev'].includes($app.stage),
      }
    )
  : undefined;

/**
 * WAF Logging Configuration - connects WebACL to CloudWatch Logs.
 *
 * This resource:
 * 1. Enables real-time logging for all traffic evaluated by the WebACL
 * 2. Sends logs to the CloudWatch log group automatically
 * 3. Redacts sensitive headers (authorization, cookie) to protect PII and credentials
 *
 * The log format is AWS WAF's standard JSON structure containing all fields
 * required by the 4 Security Dashboard graphs:
 * - Traffic characteristics (attack types, countries)
 * - Managed rule evaluation results (labels, terminated requests)
 * - Time-series data for trending and analysis
 *
 * Backend discovery process (apps/client/server/security/wafLogsInsights.ts):
 * 1. Calls GetLoggingConfigurationCommand on the WebACL
 * 2. Extracts log group ARN from LogDestinationConfigs
 * 3. Parses region and log group name from ARN
 * 4. Runs CloudWatch Logs Insights queries to populate graphs
 *
 * Logs appear within 2-3 minutes of the first request hitting the WebACL.
 */
/**
 * WebACL ARN exposed as a Linkable so frontend Lambda can read it from resource.enc
 * without generating additional IAM statements (unlike direct SST resource linking).
 * The explicit wafv2:GetLoggingConfiguration permission in infra/web.ts already grants
 * the runtime access needed.
 */
export const wafWebAclArn = wafWebAcl
  ? new sst.Linkable('WafWebAclArn', {
      properties: {
        arn: wafWebAcl.arn,
      },
    })
  : undefined;

export const wafLoggingConfig =
  isWafEnabled && wafWebAcl && wafLogGroup
    ? new aws.wafv2.WebAclLoggingConfiguration(
        'WafLoggingConfiguration',
        {
          // WebACL to enable logging for
          resourceArn: wafWebAcl.arn,
          // CloudWatch log group destination (AWS requires :* suffix)
          logDestinationConfigs: [wafLogGroup.arn.apply(arn => `${arn}:*`)],
          // Redact sensitive headers to prevent logging PII/credentials
          // Values are replaced with 'REDACTED' in logs while keeping field names visible
          redactedFields: [{ singleHeader: { name: 'authorization' } }, { singleHeader: { name: 'cookie' } }],
        },
        {
          // MUST be us-east-1 for CloudFront-scope WAF
          provider: wafProviderUsEast1,
          // No retainOnDelete needed - lifecycle is tied to WebACL
          // If WebACL is deleted, this logging configuration is automatically removed
        }
      )
    : undefined;

/**
 * SNS topic for WAF AI rate-limit block alerts (production only).
 *
 * Subscribe the on-call channel to receive pages when the ai-route-rate-limit rule
 * blocks more than 50 requests in a 5-minute window.
 *
 * Emergency rollback if the rule is misfiring:
 *   Fast path — change "Action": {"Block": {}} to "Action": {"Count": {}} in
 *   infra/waf/bike4mind-api-protection-prod.json and redeploy. The rule stays active
 *   but stops blocking; CloudWatch metrics keep accumulating so you can observe impact.
 *   Hard rollback — remove the ai-route-rate-limit rule from the JSON and redeploy.
 */
export const wafAiRateLimitAlarmTopic =
  isWafEnabled && $app.stage === 'production'
    ? new aws.sns.Topic(
        'WafAiRateLimitAlarmTopic',
        { name: `${$app.name}-${$app.stage}-waf-ai-rate-limit-alarm` },
        { provider: wafProviderUsEast1 }
      )
    : undefined;

/**
 * Lambda handler that forwards WAF alarm notifications to Slack.
 * Created in the default region; SNS cross-region invocation carries the
 * alarm payload from us-east-1 to the handler.
 */
export const wafAlarmSlackHandler =
  isWafEnabled && $app.stage === 'production'
    ? new sst.aws.Function('WafAlarmSlackHandler', {
        handler: 'apps/client/server/events/wafAlarmToSlack.handler',
        link: [secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL],
        environment: { ...DEFAULT_LAMBDA_ENVIRONMENT },
        logging: { retention: '1 month' },
      })
    : undefined;

if (isWafEnabled && $app.stage === 'production' && wafAiRateLimitAlarmTopic && wafAlarmSlackHandler) {
  // Allow the us-east-1 SNS topic to invoke the Lambda handler.
  // Captured in a variable so the subscription can declare a dependsOn — without it
  // Pulumi creates both resources in parallel and SNS may attempt subscription
  // confirmation before the permission exists, leaving it permanently PendingConfirmation.
  const wafAlarmSlackHandlerSnsPermission = new aws.lambda.Permission('WafAlarmSlackHandlerSnsPermission', {
    action: 'lambda:InvokeFunction',
    function: wafAlarmSlackHandler.arn,
    principal: 'sns.amazonaws.com',
    sourceArn: wafAiRateLimitAlarmTopic.arn,
  });

  // DLQ for failed SNS→Lambda invocations. Must live in us-east-1 to match the SNS topic region.
  const wafAlarmDlq = new aws.sqs.Queue(
    'WafAlarmSlackHandlerDlq',
    { messageRetentionSeconds: 14 * 24 * 3600 },
    { provider: wafProviderUsEast1 }
  );

  const wafAlarmDlqPolicy = new aws.sqs.QueuePolicy(
    'WafAlarmSlackHandlerDlqPolicy',
    {
      queueUrl: wafAlarmDlq.url,
      policy: $util.all([wafAlarmDlq.arn, wafAiRateLimitAlarmTopic.arn]).apply(([dlqArn, topicArn]) =>
        JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'sns.amazonaws.com' },
              Action: 'sqs:SendMessage',
              Resource: dlqArn,
              Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
            },
          ],
        })
      ),
    },
    { provider: wafProviderUsEast1 }
  );

  // Wire SNS topic (us-east-1) → Lambda handler via cross-region subscription.
  new aws.sns.TopicSubscription(
    'WafAlarmSlackHandlerSubscription',
    {
      topic: wafAiRateLimitAlarmTopic.arn,
      protocol: 'lambda',
      endpoint: wafAlarmSlackHandler.arn,
      redrivePolicy: wafAlarmDlq.arn.apply(arn => JSON.stringify({ deadLetterTargetArn: arn })),
    },
    { provider: wafProviderUsEast1, dependsOn: [wafAlarmSlackHandlerSnsPermission, wafAlarmDlqPolicy] }
  );
}

if (isWafEnabled && $app.stage === 'production' && wafWebAcl && wafAiRateLimitAlarmTopic) {
  // CloudFront-scope WAF publishes metrics to us-east-1 with Region=Global.
  // The alarm must be created in us-east-1 via wafProviderUsEast1.
  new aws.cloudwatch.MetricAlarm(
    'wafAiRateLimitBlocks',
    {
      name: `${$app.name}-${$app.stage}-waf-ai-rate-limit-blocks`,
      alarmDescription:
        'WAF ai-route-rate-limit blocked >50 req/5min in production — possible misfire or attack. Fast rollback: set Action→Count in infra/waf/bike4mind-api-protection-prod.json and redeploy.',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      metricName: 'BlockedRequests',
      namespace: 'AWS/WAFV2',
      period: 300,
      statistic: 'Sum',
      threshold: 50,
      treatMissingData: 'notBreaching',
      dimensions: {
        Rule: 'ai-route-rate-limit',
        WebACL: wafWebAcl.name,
        Region: 'Global',
      },
      alarmActions: [wafAiRateLimitAlarmTopic.arn],
      tags: {
        Application: 'WAF',
        Severity: 'High',
      },
    },
    { provider: wafProviderUsEast1 }
  );
}

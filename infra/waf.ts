/**
 * WAF for the Router CloudFront distribution, controlled by the ENABLE_WAF environment variable
 * (default: false).
 *
 * A stage with WAF_WEB_ACL_NAME set looks up an externally managed WebACL by name (see
 * wafAssociation.ts); otherwise non-production stages create their own CloudFront-scope WebACL in
 * us-east-1. Production always uses the external ACL and also creates the alert delivery resources
 * below.
 */

import { buildDevWafRuleJson, getDevWafMeta, parseWafBlockedIps } from './wafPolicy';
import { resolveExternalWafAssociation, resolveWafLabelForwarding, resolveWafLogDestination } from './wafAssociation';
import { WAF_REDACTED_HEADERS } from './wafRedaction';
import { secrets } from './secrets';
import { alarmSlackMentionFunctionArgs } from './alarmSlackMention';
import { DEFAULT_LAMBDA_ENVIRONMENT } from './constants';
import { buildDlqAgeMetricQueries } from '@bike4mind/infra';
import { parseAlarmThreshold, SIGNUP_EDGE_SIGNAL_DEFAULT } from './signupAlarmThreshold';

// WAF is disabled by default. Enable via ENABLE_WAF=true environment variable.
// For production and dev, set ENABLE_WAF=true in GitHub Variables.
const isWafEnabled = process.env.ENABLE_WAF === 'true';

const externalWaf = resolveExternalWafAssociation({
  stage: $app.stage,
  enableWaf: process.env.ENABLE_WAF,
  webAclName: process.env.WAF_WEB_ACL_NAME,
});

// The alert delivery resources and the topics they use exist for production only.
const productionAlerts = $app.stage === 'production' ? externalWaf : undefined;

// CloudFront-scope WAF resources must be created in us-east-1.
const wafProviderUsEast1 = isWafEnabled
  ? new aws.Provider('waf-us-east-1', {
      region: 'us-east-1',
    })
  : undefined;

/**
 * Emergency IP block set.
 *
 * WAF_BLOCKED_IPS (comma-separated IPv4 or CIDR) only seeds the set on first create; runtime edits are the source of truth.
 * WAF requires at least one address, so an empty list falls back to a TEST-NET placeholder that never appears in real traffic.
 */
export const wafEmergencyIpSet =
  isWafEnabled && !externalWaf
    ? new aws.wafv2.IpSet(
        'WafEmergencyIpBlockSet',
        {
          name: `emergency-ip-block-${$app.stage}`,
          // WAF description regex does not allow parentheses.
          description: `Emergency IP block list - ${$app.stage}`,
          scope: 'CLOUDFRONT',
          ipAddressVersion: 'IPV4',
          addresses: parseWafBlockedIps(process.env.WAF_BLOCKED_IPS),
        },
        {
          provider: wafProviderUsEast1,
          // Retain IPSet for the permanent stage only; PR stages are torn down and recreated,
          // so retaining would orphan the resource and cause WAFDuplicateItemException on redeploy.
          retainOnDelete: $app.stage === 'dev',
          ignoreChanges: ['addresses', 'lockToken'],
        }
      )
    : undefined;

/**
 * IPs the path-scoped rate rules do not count (our own and allowlisted addresses). Addresses come
 * from the WAF_RATE_EXEMPT_IPS deploy variable, same format and placeholder as the emergency set.
 * It only narrows what rate rules count; it never allows a request past any other rule.
 */
export const wafRateExemptIpSet =
  isWafEnabled && !externalWaf
    ? new aws.wafv2.IpSet(
        'WafRateExemptIpSet',
        {
          name: $app.stage === 'production' ? 'rate-exempt-ip-prod' : `rate-exempt-ip-${$app.stage}`,
          description: `Rate rule exempt IP list - ${$app.stage}`,
          scope: 'CLOUDFRONT',
          ipAddressVersion: 'IPV4',
          addresses: parseWafBlockedIps(process.env.WAF_RATE_EXEMPT_IPS, 'WAF_RATE_EXEMPT_IPS'),
        },
        {
          provider: wafProviderUsEast1,
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
 * Retention: 30 days (cost optimization, sufficient for debugging and testing).
 */
export const wafLogGroup =
  isWafEnabled && !externalWaf
    ? new aws.cloudwatch.LogGroup(
        'WafLogGroup',
        {
          // CRITICAL: MUST start with 'aws-waf-logs-' (see comment above)
          name: `aws-waf-logs-bike4mind-${$app.stage}`,
          retentionInDays: 30,
        },
        {
          // MUST be us-east-1 for CloudFront-scope WAF
          provider: wafProviderUsEast1,
          // Retain logs for dev (safety net), auto-delete for PR stages (cleanup)
          retainOnDelete: $app.stage === 'dev',
        }
      )
    : undefined;

/**
 * WebACL built from the exported policy.
 */
export const wafStageWebAcl =
  isWafEnabled && !externalWaf
    ? new aws.wafv2.WebAcl(
        'WafWebAcl',
        (() => {
          // Each stage gets its own WebACL (e.g., bike4mind-api-protection-pr6391)
          const policy = getDevWafMeta({ nameSuffix: $app.stage, stage: $app.stage });

          const ruleJson = $util
            .all([wafEmergencyIpSet!.arn, wafRateExemptIpSet!.arn])
            .apply(([emergencyIpSetArn, rateExemptIpSetArn]) =>
              buildDevWafRuleJson({ emergencyIpSetArn, rateExemptIpSetArn, stage: $app.stage })
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
          // Retain WebACL for the permanent stage only, same reasoning as IPSet above.
          retainOnDelete: $app.stage === 'dev',
        }
      )
    : undefined;

/**
 * The externally managed WebACL, looked up by name.
 */
const externalWebAcl = externalWaf
  ? aws.wafv2.getWebAclOutput({ name: externalWaf.webAclName, scope: 'CLOUDFRONT' }, { provider: wafProviderUsEast1 })
  : undefined;

/** ARN of the WebACL attached to the CDN: the looked-up one when WAF_WEB_ACL_NAME is set, the stage-owned one otherwise. */
export const wafWebAcl = externalWebAcl ?? wafStageWebAcl;

/** Read by infra/web.ts to set WAF_LABEL_FORWARDING on the server function. */
export const wafLabelForwarding = resolveWafLabelForwarding({
  attachedAcl: externalWebAcl ? 'external' : wafStageWebAcl ? 'stage' : 'none',
  labelForwarding: process.env.WAF_LABEL_FORWARDING,
});
const wafWebAclArnValue = wafWebAcl?.arn;

// Read the external owner's configuration without taking ownership of it.
const externalLoggingConfig = externalWebAcl
  ? aws.wafv2.WebAclLoggingConfiguration.get('ExternalWafLoggingConfiguration', externalWebAcl.arn, undefined, {
      provider: wafProviderUsEast1,
    })
  : undefined;
const externalLogDestination = externalLoggingConfig?.logDestinationConfigs.apply(resolveWafLogDestination);

export const wafLogGroupArn = externalLogDestination
  ? externalLogDestination.apply(destination => `${destination.arn}:*`)
  : wafLogGroup?.arn.apply(arn => `${arn.replace(/:\*$/, '')}:*`);
const wafLogGroupName = externalLogDestination
  ? externalLogDestination.apply(destination => destination.name)
  : wafLogGroup?.name;

// Personal stages can use the shared dev router even without a local WAF resource.
const partition = aws.getPartitionOutput().partition;
const queryWebAclArn =
  wafWebAcl?.arn ??
  $interpolate`arn:${partition}:wafv2:us-east-1:${aws.getCallerIdentityOutput().accountId}:global/webacl/bike4mind-api-protection-*`;
const queryLogGroupArn =
  wafLogGroupArn ??
  $interpolate`arn:${partition}:logs:us-east-1:${aws.getCallerIdentityOutput().accountId}:log-group:aws-waf-logs-bike4mind-*`;

export const wafReadPermissions = [
  { actions: ['logs:StartQuery', 'logs:GetQueryResults'], resources: [queryLogGroupArn] },
  // StopQuery does not support resource-level permissions.
  { actions: ['logs:StopQuery'], resources: ['*'] },
  { actions: ['wafv2:GetLoggingConfiguration'], resources: [queryWebAclArn] },
];

/**
 * WAF Logging Configuration - connects WebACL to CloudWatch Logs.
 *
 * This resource:
 * 1. Enables real-time logging for all traffic evaluated by the WebACL
 * 2. Sends logs to the CloudWatch log group automatically
 * 3. Redacts every credential-bearing header listed in infra/wafRedaction.ts
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
export const wafWebAclArn = wafWebAclArnValue
  ? new sst.Linkable('WafWebAclArn', {
      properties: {
        arn: wafWebAclArnValue,
      },
    })
  : undefined;

export const wafLoggingConfig =
  wafStageWebAcl && wafLogGroup
    ? new aws.wafv2.WebAclLoggingConfiguration(
        'WafLoggingConfiguration',
        {
          // WebACL to enable logging for
          resourceArn: wafStageWebAcl.arn,
          // CloudWatch log group destination (AWS requires :* suffix)
          logDestinationConfigs: [wafLogGroup.arn.apply(arn => `${arn}:*`)],
          // Values are replaced with 'REDACTED' in logs while keeping field names visible.
          // Redaction applies from the moment this configuration is updated; log records already
          // written keep whatever they captured until the group's retention window expires.
          redactedFields: WAF_REDACTED_HEADERS.map(name => ({ singleHeader: { name } })),
        },
        {
          // MUST be us-east-1 for CloudFront-scope WAF
          provider: wafProviderUsEast1,
          // Retained so removing only this resource never turns logging off; AWS still drops it with the WebACL
          retainOnDelete: ['production', 'dev'].includes($app.stage),
        }
      )
    : undefined;

/**
 * ARN of the externally managed rate-limit alarm topic (production only). Looked up rather than
 * constructed so a missing topic fails the deploy instead of leaving a dangling subscription.
 */
const wafAiRateLimitAlarmTopicArn = productionAlerts
  ? aws.sns.getTopicOutput(
      { name: `${$app.name}-${$app.stage}-waf-ai-rate-limit-alarm` },
      { provider: wafProviderUsEast1 }
    ).arn
  : undefined;

/**
 * Email-only us-east-1 topic (OPS_ALERT_EMAIL subscription below); delivery does not depend on
 * the Slack forwarding Lambda. Separate from the OobAlarmTopic in dlqAlarms.ts because
 * CloudWatch alarm actions must be in the alarm's region, and the WAF alarms live in us-east-1.
 */
export const wafOobAlarmTopic = productionAlerts
  ? new aws.sns.Topic(
      'WafOobAlarmTopic',
      { name: `${$app.name}-${$app.stage}-waf-oob-alarm` },
      // Retained so subscriptions added outside this stack keep a stable topic ARN
      { provider: wafProviderUsEast1, retainOnDelete: true }
    )
  : undefined;

/**
 * Lambda handler that forwards WAF alarm notifications to Slack.
 * Created in the default region; SNS cross-region invocation carries the
 * alarm payload from us-east-1 to the handler.
 */
const wafMentionArgs = alarmSlackMentionFunctionArgs();
export const wafAlarmSlackHandler = productionAlerts
  ? new sst.aws.Function('WafAlarmSlackHandler', {
      handler: 'apps/workers/src/events/wafAlarmToSlack.handler',
      link: [secrets.SLACK_ERROR_REPORTING_WEBHOOK_URL, secrets.SLACK_ALARMS_WEBHOOK_URL],
      environment: { ...DEFAULT_LAMBDA_ENVIRONMENT, ...wafMentionArgs.environment },
      permissions: wafMentionArgs.permissions,
      logging: { retention: '1 month' },
    })
  : undefined;

if (productionAlerts && wafAiRateLimitAlarmTopicArn && wafOobAlarmTopic && wafAlarmSlackHandler) {
  // Allow the us-east-1 SNS topic to invoke the Lambda handler.
  // Captured in a variable so the subscription can declare a dependsOn — without it
  // Pulumi creates both resources in parallel and SNS may attempt subscription
  // confirmation before the permission exists, leaving it permanently PendingConfirmation.
  const wafAlarmSlackHandlerSnsPermission = new aws.lambda.Permission('WafAlarmSlackHandlerSnsPermission', {
    action: 'lambda:InvokeFunction',
    function: wafAlarmSlackHandler.arn,
    principal: 'sns.amazonaws.com',
    sourceArn: wafAiRateLimitAlarmTopicArn,
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
      policy: $util.all([wafAlarmDlq.arn, wafAiRateLimitAlarmTopicArn]).apply(([dlqArn, topicArn]) =>
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
      topic: wafAiRateLimitAlarmTopicArn,
      protocol: 'lambda',
      endpoint: wafAlarmSlackHandler.arn,
      redrivePolicy: wafAlarmDlq.arn.apply(arn => JSON.stringify({ deadLetterTargetArn: arn })),
    },
    { provider: wafProviderUsEast1, dependsOn: [wafAlarmSlackHandlerSnsPermission, wafAlarmDlqPolicy] }
  );

  // Out-of-band alarm for WafAlarmSlackHandlerDlq itself routes to wafOobAlarmTopic.
  // Cannot route to the rate-limit alarm topic -- that would loop into the same failing Lambda.
  // NOTE: after the first deploy, check your inbox for an SNS confirmation email and click
  // the link -- subscriptions stay in PendingConfirmation and deliver nothing until confirmed.
  if (process.env.OPS_ALERT_EMAIL) {
    // retainOnDelete: same reason as OobAlarmTopicEmailSub in dlqAlarms.ts -- the AWS
    // provider cannot destroy a PendingConfirmation subscription, so retain it rather
    // than leaving dangling state if the variable is removed before confirmation.
    // Note: rotating OPS_ALERT_EMAIL is a replace (endpoint is force-new), so the old
    // subscription is retained rather than unsubscribed -- manually unsubscribe the old
    // endpoint from the SNS console (us-east-1) after any address change.
    new aws.sns.TopicSubscription(
      'WafOobAlarmTopicEmailSub',
      {
        topic: wafOobAlarmTopic.arn,
        protocol: 'email',
        endpoint: process.env.OPS_ALERT_EMAIL,
      },
      { provider: wafProviderUsEast1, retainOnDelete: true }
    );
  } else {
    console.warn(
      `[WARN] OPS_ALERT_EMAIL is unset on stage '${$app.stage}'. ` +
        `WafOobAlarmTopic will be created with no subscriber -- WafAlarmSlackHandlerDlq alarms ` +
        `will publish into the void. Set OPS_ALERT_EMAIL in the deploy pipeline variables.`
    );
  }

  // Message-count alarm: any message in the DLQ means WAF alert delivery to Slack is failing.
  // evaluationPeriods: 1 is intentional -- any DLQ message here is an immediate failure
  // signal, not transient noise, so a single breaching period is the right sensitivity.
  new aws.cloudwatch.MetricAlarm(
    'WafAlarmSlackHandlerDlqMessages',
    {
      name: `${$app.name}-${$app.stage}-waf-alarm-slack-handler-dlq-messages`,
      alarmDescription:
        'WafAlarmSlackHandlerDlq has messages -- WAF rate-limit alert delivery to Slack is failing; check SLACK_ALARMS_WEBHOOK_URL, SLACK_ERROR_REPORTING_WEBHOOK_URL and Lambda errors.',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      metricName: 'ApproximateNumberOfMessagesVisible',
      namespace: 'AWS/SQS',
      period: 60,
      statistic: 'Maximum',
      threshold: 0,
      treatMissingData: 'ignore',
      dimensions: { QueueName: wafAlarmDlq.name },
      alarmActions: [wafOobAlarmTopic.arn],
      tags: { Application: 'WAF', Severity: 'Critical', MonitoringType: 'DLQ' },
    },
    { provider: wafProviderUsEast1 }
  );

  // Age alarm: same 1-hour threshold as the standard DLQ fleet. period is 60s (vs fleet
  // 300s) to match the message-count alarm above and keep both alarms on the same cadence.
  new aws.cloudwatch.MetricAlarm(
    'WafAlarmSlackHandlerDlqAge',
    {
      name: `${$app.name}-${$app.stage}-waf-alarm-slack-handler-dlq-age`,
      alarmDescription:
        'WafAlarmSlackHandlerDlq oldest message exceeds 1 hour -- WAF alert delivery to Slack has been failing for an extended period.',
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 1,
      threshold: 3600,
      treatMissingData: 'ignore',
      // Same IF(visible > 0, age, 0) metric math as the fleet age alarms; see
      // b4m-core/infra/src/dlqAlarmSpecs.ts for why and its residuals.
      metricQueries: buildDlqAgeMetricQueries(60, { QueueName: wafAlarmDlq.name }),
      alarmActions: [wafOobAlarmTopic.arn],
      tags: { Application: 'WAF', Severity: 'High', MonitoringType: 'DLQ' },
    },
    { provider: wafProviderUsEast1 }
  );
}

/**
 * Sign-in code requests that the managed rule groups label as hosting-provider or bot-control
 * traffic. The labels are attached whether the rule blocks or only counts, so this alarms on
 * automated signup attempts even while those rules are in Count mode.
 */
export const WAF_OTC_EDGE_SIGNAL_FILTER_PATTERN =
  '{ $.httpRequest.uri = "/api/otc/*" && ' +
  '($.labels[*].name = "awswaf:managed:aws:anonymous-ip-list:HostingProviderIPList" || ' +
  '$.labels[*].name = "awswaf:managed:aws:bot-control:signal:*") }';

if (productionAlerts && wafAiRateLimitAlarmTopicArn && wafOobAlarmTopic) {
  const edgeSignalThreshold = parseAlarmThreshold(
    'SIGNUP_EDGE_SIGNAL_ALARM_PER_5MIN',
    process.env.SIGNUP_EDGE_SIGNAL_ALARM_PER_5MIN,
    SIGNUP_EDGE_SIGNAL_DEFAULT
  );
  const signupNamespace = `${$app.name}/${$app.stage}/Signup`;
  const actions = [wafAiRateLimitAlarmTopicArn, wafOobAlarmTopic.arn];

  // Follow the selected ACL's logging destination, including externally chosen group names.
  new aws.cloudwatch.LogMetricFilter(
    'wafOtcEdgeSignalFilter',
    {
      name: `${$app.name}-${$app.stage}-waf-otc-edge-signals`,
      logGroupName: wafLogGroupName!,
      pattern: WAF_OTC_EDGE_SIGNAL_FILTER_PATTERN,
      metricTransformation: {
        name: 'OtcEdgeSignalRequests',
        namespace: signupNamespace,
        value: '1',
        unit: 'Count',
      },
    },
    { provider: wafProviderUsEast1 }
  );

  new aws.cloudwatch.MetricAlarm(
    'wafOtcEdgeSignalRate',
    {
      name: `${$app.name}-${$app.stage}-waf-otc-edge-signal-rate`,
      alarmDescription:
        'Sign-in code requests from hosting-provider or bot-control labelled clients per 5 minutes at or above the ceiling',
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      evaluationPeriods: 1,
      metricName: 'OtcEdgeSignalRequests',
      namespace: signupNamespace,
      period: 300,
      statistic: 'Sum',
      threshold: edgeSignalThreshold,
      treatMissingData: 'notBreaching',
      alarmActions: actions,
      okActions: actions,
      tags: { Application: 'Signup', Severity: 'High' },
    },
    { provider: wafProviderUsEast1 }
  );
}

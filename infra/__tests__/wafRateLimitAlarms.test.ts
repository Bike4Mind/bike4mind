/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';

const usEast1 = expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) });

const resources = vi.hoisted(() => {
  function output<T>(value: T): { apply: <Result>(callback: (input: T) => Result) => Result } {
    return { apply: callback => callback(value) };
  }
  const resource = vi.fn(function (name: string, args: Record<string, unknown>) {
    return { ...args, name: args.name ?? name, arn: output(`${name}-arn`), url: `${name}-url` };
  });
  const alarm = vi.fn(function (_name: string, _args: Record<string, unknown>, _options: unknown) {});
  const filter = vi.fn(function (_name: string, _args: Record<string, unknown>, _options: unknown) {});
  const topicLookup = vi.fn((_args: Record<string, unknown>, _options: unknown) => ({ arn: 'looked-up-topic-arn' }));
  const aclLookup = vi.fn((_args: Record<string, unknown>, _options: unknown) => ({
    arn: output('looked-up-acl-arn'),
  }));
  const loggingRead = vi.fn((_name: string, _arn: unknown, _state: unknown, _options: unknown) => ({
    logDestinationConfigs: {
      apply: <Result>(callback: (value: string[]) => Result) =>
        output(callback(['arn:test:logs:us-east-1:deployment-account:log-group:aws-waf-logs-custom'])),
    },
  }));
  return { output, resource, alarm, filter, topicLookup, aclLookup, loggingRead };
});

vi.mock('../secrets', () => ({ secrets: { SLACK_ERROR_REPORTING_WEBHOOK_URL: 'webhook-secret' } }));
vi.mock('../constants', () => ({ DEFAULT_LAMBDA_ENVIRONMENT: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function loadWafResources(): Promise<void> {
  vi.resetModules();
  vi.stubEnv('ENABLE_WAF', 'true');
  vi.stubEnv('WAF_WEB_ACL_NAME', 'bike4mind-api-protection-prod');
  vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com');
  vi.stubGlobal('$app', { name: 'test-app', stage: 'production' });
  vi.stubGlobal('$util', { all: resources.output });
  vi.stubGlobal('aws', {
    getPartitionOutput: () => ({ partition: 'test' }),
    Provider: resources.resource,
    wafv2: { getWebAclOutput: resources.aclLookup, WebAclLoggingConfiguration: { get: resources.loggingRead } },
    cloudwatch: { MetricAlarm: resources.alarm, LogMetricFilter: resources.filter },
    sns: { Topic: resources.resource, TopicSubscription: resources.resource, getTopicOutput: resources.topicLookup },
    lambda: { Permission: resources.resource },
    ssm: { Parameter: resources.resource },
    sqs: { Queue: resources.resource, QueuePolicy: resources.resource },
  });
  vi.stubGlobal('sst', { Linkable: resources.resource, aws: { Function: resources.resource } });
  await import('../waf');
}

describe('WAF sign-in code edge-signal alarm', () => {
  it('counts labelled /api/otc/ requests on the us-east-1 WAF log group by name', async () => {
    await loadWafResources();

    expect(resources.filter).toHaveBeenCalledExactlyOnceWith(
      'wafOtcEdgeSignalFilter',
      {
        name: 'test-app-production-waf-otc-edge-signals',
        logGroupName: 'aws-waf-logs-custom',
        pattern:
          '{ $.httpRequest.uri = "/api/otc/*" && ' +
          '($.labels[*].name = "awswaf:managed:aws:anonymous-ip-list:HostingProviderIPList" || ' +
          '$.labels[*].name = "awswaf:managed:aws:bot-control:signal:*") }',
        metricTransformation: {
          name: 'OtcEdgeSignalRequests',
          namespace: 'test-app/production/Signup',
          value: '1',
          unit: 'Count',
        },
      },
      usEast1
    );
  });

  it('alarms at 5 per 5 minutes to the looked-up Slack topic only', async () => {
    await loadWafResources();

    type Arn = { apply: (callback: (value: string) => string) => string };
    const resolve = (arns: unknown) =>
      (arns as (string | Arn)[]).map(arn => (typeof arn === 'string' ? arn : arn.apply(v => v)));
    const actions = ['looked-up-topic-arn'];
    const call = resources.alarm.mock.calls.find(([name]) => name === 'wafOtcEdgeSignalRate');
    expect(call?.[1]).toMatchObject({
      metricName: 'OtcEdgeSignalRequests',
      namespace: 'test-app/production/Signup',
      period: 300,
      statistic: 'Sum',
      threshold: 5,
      comparisonOperator: 'GreaterThanOrEqualToThreshold',
      treatMissingData: 'notBreaching',
    });
    expect(resolve(call?.[1].alarmActions)).toEqual(actions);
    expect(resolve(call?.[1].okActions)).toEqual(actions);
    expect(call?.[2]).toEqual(usEast1);
  });

  it('reads a configured ceiling', async () => {
    vi.stubEnv('SIGNUP_EDGE_SIGNAL_ALARM_PER_5MIN', '12');
    await loadWafResources();

    expect(resources.alarm.mock.calls.find(([name]) => name === 'wafOtcEdgeSignalRate')?.[1].threshold).toBe(12);
  });

  it('keeps the out-of-band topic and its email subscription', async () => {
    await loadWafResources();

    const names = resources.resource.mock.calls.map(([name]) => name);
    expect(names).toContain('WafOobAlarmTopic');
    expect(names).toContain('WafOobAlarmTopicEmailSub');
  });
});

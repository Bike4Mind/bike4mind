/** @vitest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWafRateLimitAlarmRules } from '../wafPolicy';

const temporaryDirectories: string[] = [];

const resources = vi.hoisted(() => {
  function output<T>(value: T): { value: T; apply: <Result>(callback: (input: T) => Result) => Result } {
    return { value, apply: callback => callback(value) };
  }
  const resource = vi.fn(function (name: string, args: Record<string, unknown>) {
    return {
      ...args,
      // Keep the resource name distinct so a mistaken dimension using WebACL.name fails.
      name: name === 'WafWebAcl' ? 'physical-webacl-name' : (args.name ?? name),
      arn: output(`${name}-arn`),
      url: `${name}-url`,
    };
  });
  const alarm = vi.fn(function (_name: string, _args: Record<string, unknown>, _options: unknown) {});
  return { output, resource, alarm };
});

vi.mock('../secrets', () => ({ secrets: { SLACK_ERROR_REPORTING_WEBHOOK_URL: 'webhook-secret' } }));
vi.mock('../constants', () => ({ DEFAULT_LAMBDA_ENVIRONMENT: {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

type FixtureRule = {
  Name: string;
  Statement: Record<string, unknown>;
  Action: Record<string, unknown>;
  VisibilityConfig: {
    CloudWatchMetricsEnabled: boolean;
    MetricName: string;
    SampledRequestsEnabled: boolean;
  };
};

function rateRule(name: string, metricName = name): FixtureRule {
  return {
    Name: name,
    Statement: { RateBasedStatement: { Limit: 100, AggregateKeyType: 'IP' } },
    Action: { Block: {} },
    VisibilityConfig: {
      CloudWatchMetricsEnabled: true,
      MetricName: metricName,
      SampledRequestsEnabled: true,
    },
  };
}

function useProductionPolicy(rules: FixtureRule[]): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waf-alarm-policy-'));
  temporaryDirectories.push(directory);
  fs.writeFileSync(
    path.join(directory, 'bike4mind-api-protection-prod.json'),
    JSON.stringify({
      Name: 'deployment-firewall',
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: true,
        MetricName: 'deployment-firewall-metric',
        SampledRequestsEnabled: true,
      },
      Rules: rules.map((rule, priority) => ({ ...rule, Priority: priority })),
    })
  );
  vi.stubEnv('WAF_POLICY_DIR', directory);
}

async function loadWafResources(rateExemptIps = ''): Promise<void> {
  vi.resetModules();
  vi.stubEnv('ENABLE_WAF', 'true');
  vi.stubEnv('WAF_BLOCKED_IPS', '');
  vi.stubEnv('WAF_RATE_EXEMPT_IPS', rateExemptIps);
  vi.stubEnv('OPS_ALERT_EMAIL', 'ops@example.com');
  vi.stubGlobal('$app', { name: 'test-app', stage: 'production' });
  vi.stubGlobal('$util', {
    all: (values: { value: unknown }[]) => resources.output(values.map(output => output.value)),
  });
  vi.stubGlobal('aws', {
    Provider: resources.resource,
    wafv2: {
      IpSet: resources.resource,
      WebAcl: resources.resource,
      WebAclLoggingConfiguration: resources.resource,
    },
    cloudwatch: { LogGroup: resources.resource, MetricAlarm: resources.alarm },
    sns: { Topic: resources.resource, TopicSubscription: resources.resource },
    lambda: { Permission: resources.resource },
    sqs: { Queue: resources.resource, QueuePolicy: resources.resource },
  });
  vi.stubGlobal('sst', { Linkable: resources.resource, aws: { Function: resources.resource } });
  await import('../waf');
}

describe('getWafRateLimitAlarmRules', () => {
  it('selects the six enforcing production rate limits from the sample policy', () => {
    vi.stubEnv('WAF_POLICY_DIR', '');

    expect(getWafRateLimitAlarmRules('production')).toEqual(
      [
        'ai-route-rate-limit',
        'api-rate-limit',
        'register-rate-limit',
        'otc-verify-rate-limit',
        'api-key-create-rate-limit',
        'credits-rate-limit',
      ].map(name => ({ name, metricName: name }))
    );
  });

  it('uses the deployment metric name rather than the rule name', () => {
    useProductionPolicy([rateRule('api-limit', 'api-blocked-requests')]);

    expect(getWafRateLimitAlarmRules('production')).toEqual([
      { name: 'api-limit', metricName: 'api-blocked-requests' },
    ]);
  });

  it('omits rate limits rolled back to Count', () => {
    useProductionPolicy([{ ...rateRule('rolled-back-limit'), Action: { Count: {} } }]);

    expect(getWafRateLimitAlarmRules('production')).toEqual([]);
  });

  it('omits rules whose CloudWatch metrics are disabled', () => {
    const rule = rateRule('unreported-limit');
    useProductionPolicy([{ ...rule, VisibilityConfig: { ...rule.VisibilityConfig, CloudWatchMetricsEnabled: false } }]);

    expect(getWafRateLimitAlarmRules('production')).toEqual([]);
  });

  it('includes additional deployment rate rules and excludes non-rate rules', () => {
    useProductionPolicy([
      rateRule('deployment-only-limit', 'deployment-only-metric'),
      {
        ...rateRule('static-ip-block'),
        Statement: { IPSetReferenceStatement: { ARN: 'deployment-ipset' } },
      },
      {
        ...rateRule('managed-rules'),
        Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } },
      },
    ]);

    expect(getWafRateLimitAlarmRules('production')).toEqual([
      { name: 'deployment-only-limit', metricName: 'deployment-only-metric' },
    ]);
  });

  it('selects the non-production policy for preview stages and omits Count shadows', () => {
    vi.stubEnv('WAF_POLICY_DIR', '');

    expect(getWafRateLimitAlarmRules('pr5655').map(rule => rule.name)).toEqual([
      'api-rate-limit',
      'static-asset-rate-limit',
      'register-rate-limit',
      'otc-verify-rate-limit',
      'api-key-create-rate-limit',
      'credits-rate-limit',
    ]);
  });
});

describe('WAF rate-limit alarm wiring', () => {
  it('wires the exempt addresses and ARN without changing the emergency block set', async () => {
    vi.stubEnv('WAF_POLICY_DIR', '');
    await loadWafResources('192.0.2.1, 198.51.100.0/24');

    expect(resources.resource).toHaveBeenCalledWith(
      'WafRateExemptIpSet',
      expect.objectContaining({ addresses: ['192.0.2.1/32', '198.51.100.0/24'], ipAddressVersion: 'IPV4' }),
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) })
    );
    const webAcl = resources.resource.mock.calls.find(([name]) => name === 'WafWebAcl');
    expect(webAcl).toBeDefined();
    const ruleJson = webAcl![1].ruleJson;
    expect(typeof ruleJson).toBe('string');
    if (typeof ruleJson !== 'string') throw new Error('Expected serialized WAF rules');
    expect(ruleJson).not.toContain('PLACEHOLDER_');
    const rules = JSON.parse(ruleJson) as { Name: string; Statement: Record<string, unknown> }[];
    expect(rules.find(rule => rule.Name === 'emergency-ip-block')!.Statement).toEqual({
      IPSetReferenceStatement: { ARN: 'WafEmergencyIpBlockSet-arn' },
    });
    for (const name of ['otc-send-rate-limit', 'credits-read-rate-limit', 'otc-send-asn-rate-limit']) {
      expect(JSON.stringify(rules.find(rule => rule.Name === name))).toContain('WafRateExemptIpSet-arn');
    }
  });

  it('creates six CloudFront rate alarms and preserves the original AI alarm resource names', async () => {
    vi.stubEnv('WAF_POLICY_DIR', '');
    await loadWafResources();

    const rateAlarms = resources.alarm.mock.calls.filter(([, args]) => args.namespace === 'AWS/WAFV2');
    expect(rateAlarms).toHaveLength(6);
    for (const [, args] of rateAlarms) {
      expect(args).toMatchObject({ metricName: 'BlockedRequests', period: 300, statistic: 'Sum', threshold: 50 });
      expect(args.dimensions).toEqual({
        Rule: expect.any(String),
        WebACL: 'bike4mind-api-protection-prod',
      });
    }
    expect(rateAlarms).toContainEqual([
      'wafAiRateLimitBlocks',
      expect.objectContaining({ name: 'test-app-production-waf-ai-rate-limit-blocks' }),
      expect.objectContaining({ provider: expect.objectContaining({ region: 'us-east-1' }) }),
    ]);
  });

  it('wires the custom rule metric and configured WebACL metric to the CloudWatch dimensions', async () => {
    useProductionPolicy([rateRule('deployment-only-limit', 'deployment-only-metric')]);
    await loadWafResources();

    const rateAlarms = resources.alarm.mock.calls.filter(([, args]) => args.namespace === 'AWS/WAFV2');
    expect(rateAlarms).toHaveLength(1);
    expect(rateAlarms[0][1].dimensions).toEqual({
      Rule: 'deployment-only-metric',
      WebACL: 'bike4mind-api-protection-prod',
    });
  });

  it('keeps distinct logical resource names for deployment rules that differ only in case', async () => {
    useProductionPolicy([rateRule('custom-rate'), rateRule('custom-Rate')]);
    await loadWafResources();

    const rateAlarms = resources.alarm.mock.calls.filter(([, args]) => args.namespace === 'AWS/WAFV2');
    expect(rateAlarms.map(([name]) => name)).toEqual(['waf-custom-rate-blocks', 'waf-custom-Rate-blocks']);
  });
});

// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListMetricsCommand,
  type GetMetricDataCommandInput,
} from '@aws-sdk/client-cloudwatch';
import { GetIPSetCommand, GetWebACLCommand, WAFV2Client, type Rule } from '@aws-sdk/client-wafv2';
import { oauthSignupsRefusedMetricName } from '../../../../../infra/authAbuseMetric';
import {
  collectIpSetRefs,
  incidentMetricSpecs,
  getIncidentSignals,
  ipSetActions,
  pickBlockerFunction,
} from '../incidentSignals';
import { WAF_CACHE_TTL, wafQueryCache } from '../wafQueryCache';

vi.mock('sst', () => ({
  Resource: {
    RouterDistributionId: { id: 'E1234567890ABC' },
    App: { name: 'bike4mind', stage: 'production' },
  },
}));

const cloudFrontMock = mockClient(CloudFrontClient);
const cloudWatchMock = mockClient(CloudWatchClient);
const wafMock = mockClient(WAFV2Client);

const ACL_ARN = 'wafv2-test:global/webacl/test-acl/acl-id';
const ipSetArn = (name: string) => `wafv2-test:global/ipset/${name}/${name}-id`;
const ts = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

const rules: Rule[] = [
  {
    Name: 'emergency',
    Priority: 0,
    Action: { Block: {} },
    Statement: { IPSetReferenceStatement: { ARN: ipSetArn('emergency-set') } },
    VisibilityConfig: undefined,
  },
  {
    Name: 'runtime',
    Priority: 1,
    Action: { Block: {} },
    Statement: {
      AndStatement: {
        Statements: [
          { OrStatement: { Statements: [{ IPSetReferenceStatement: { ARN: ipSetArn('runtime-set') } }] } },
          { ByteMatchStatement: undefined },
        ],
      },
    },
    VisibilityConfig: undefined,
  },
  {
    Name: 'watch',
    Priority: 2,
    Action: { Count: {} },
    Statement: { IPSetReferenceStatement: { ARN: ipSetArn('watch-set') } },
    VisibilityConfig: undefined,
  },
  {
    Name: 'rate',
    Priority: 3,
    Action: { Block: {} },
    Statement: {
      RateBasedStatement: {
        Limit: 100,
        AggregateKeyType: 'IP',
        ScopeDownStatement: {
          NotStatement: { Statement: { IPSetReferenceStatement: { ARN: ipSetArn('exempt-set') } } },
        },
      },
    },
    VisibilityConfig: undefined,
  },
] as Rule[];

// Placeholders: the assertion is only that no address value reaches the response.
const ADDRESSES: Record<string, string[]> = {
  'emergency-set': ['address-e1'],
  'runtime-set': ['address-r1', 'address-r2', 'address-r3'],
  'watch-set': ['address-w1', 'address-w2'],
  'exempt-set': ['address-x1'],
};

const metricValues: Record<string, number[]> = {
  m0: [4, 6],
  m1: [3, 2],
  m2: [10, 15],
  m3: [1],
  m4: [7],
  m5: [0.5, 1.25],
  m6: [],
};

function metricDataResponse(input: GetMetricDataCommandInput) {
  const first = input.MetricDataQueries?.[0]?.Id;
  if (first === 'blocker') {
    return {
      MetricDataResults: [{ Id: 'blocker', Timestamps: [ts(5), ts(10)], Values: [42, 40], StatusCode: 'Complete' }],
    };
  }
  if (first === 'm0') {
    return {
      MetricDataResults: (input.MetricDataQueries ?? []).map(query => {
        const values = metricValues[query.Id ?? ''] ?? [];
        return {
          Id: query.Id,
          Timestamps: values.map((_, i) => ts(10 + i)),
          Values: values,
          StatusCode: 'Complete',
        };
      }),
    };
  }
  return {
    MetricDataResults: [
      { Id: 'allowedA', Timestamps: [ts(10)], Values: [900], StatusCode: 'Complete' },
      { Id: 'blockedA', Timestamps: [ts(10)], Values: [80], StatusCode: 'Complete' },
      { Id: 'countedA', Timestamps: [ts(10)], Values: [20], StatusCode: 'Complete' },
    ],
  };
}

const metricQueryInput = () =>
  cloudWatchMock
    .commandCalls(GetMetricDataCommand)
    .map(call => call.args[0].input)
    .find(input => input.MetricDataQueries?.[0]?.Id === 'm0');

const originalRegion = process.env.AWS_REGION;

afterEach(() => {
  vi.useRealTimers();
  if (originalRegion === undefined) delete process.env.AWS_REGION;
  else process.env.AWS_REGION = originalRegion;
});

beforeEach(() => {
  // The default region is us-east-1 here, so the alarm listing runs in a single region.
  process.env.AWS_REGION = 'us-east-1';
  cloudFrontMock.reset();
  cloudWatchMock.reset();
  wafMock.reset();
  wafQueryCache.invalidate();

  cloudFrontMock
    .on(GetDistributionCommand)
    .resolves({ Distribution: { DistributionConfig: { WebACLId: ACL_ARN } } } as never);
  cloudWatchMock.on(GetMetricDataCommand).callsFake(metricDataResponse);
  cloudWatchMock
    .on(DescribeAlarmsCommand)
    .resolvesOnce({
      MetricAlarms: [
        {
          AlarmName: 'bike4mind-production-signup-code-send-burst',
          StateValue: 'ALARM',
          StateTransitionedTimestamp: new Date('2026-11-02T10:00:00Z'),
        },
        { AlarmName: 'bike4mind-production-api-key-create-burst', StateValue: 'OK' },
      ],
      NextToken: 'page-2',
    })
    .resolvesOnce({
      MetricAlarms: [
        {
          AlarmName: 'bike4mind-production-young-account-spend-rate',
          StateValue: 'ALARM',
          StateTransitionedTimestamp: new Date('2026-11-02T11:00:00Z'),
        },
      ],
      CompositeAlarms: [{ AlarmName: 'bike4mind-production-composite', StateValue: 'INSUFFICIENT_DATA' }],
    });
  cloudWatchMock.on(ListMetricsCommand).resolves({
    Metrics: [
      {
        Namespace: 'WafRuntimeBlocker',
        MetricName: 'ActiveEntries',
        Dimensions: [{ Name: 'Function', Value: 'runtime-blocker-prod' }],
      },
      {
        Namespace: 'WafRuntimeBlocker',
        MetricName: 'ActiveEntries',
        Dimensions: [
          { Name: 'Function', Value: 'runtime-blocker-prod' },
          { Name: 'Tier', Value: 'hot' },
        ],
      },
    ],
  });
  wafMock.on(GetWebACLCommand).resolves({ WebACL: { Name: 'test-acl', Id: 'acl-id', Rules: rules } } as never);
  wafMock.on(GetIPSetCommand).callsFake(input => ({
    IPSet: { Name: input.Name, Id: input.Id, Addresses: ADDRESSES[input.Name] ?? [] },
  }));
});

describe('getIncidentSignals', () => {
  it('sums each metric over the range from the emitters namespaces', async () => {
    const result = await getIncidentSignals('24h');

    expect(result.range).toBe('24h');
    expect(result.metrics).toEqual({
      successfulSignups: 10,
      fullGrants: 5,
      signupCodeSends: 25,
      apiKeyCreations: 1,
      oauthSignupsRefused: 7,
      youngAccountSpendUsd: 1.75,
      turnstileMisconfigured: 0,
    });
    const metrics = metricQueryInput()?.MetricDataQueries?.map(query => ({
      namespace: query.MetricStat?.Metric?.Namespace,
      name: query.MetricStat?.Metric?.MetricName,
      dimensions: query.MetricStat?.Metric?.Dimensions,
      stat: query.MetricStat?.Stat,
      period: query.MetricStat?.Period,
    }));
    expect(metrics).toEqual([
      {
        namespace: 'bike4mind/production/AccountCreation',
        name: 'SuccessfulSignups',
        dimensions: undefined,
        stat: 'Maximum',
        period: 3600,
      },
      {
        namespace: 'bike4mind/production/Signup',
        name: 'SignupGrant_full',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
      {
        namespace: 'bike4mind/production/Signup',
        name: 'SignupCodeSends',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
      {
        namespace: 'bike4mind/production/Signup',
        name: 'ApiKeyCreations',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
      {
        namespace: 'Lumina5/AuthSecurity',
        name: 'OAuthSignupsRefused',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
      {
        namespace: 'bike4mind/production/LLMSpend',
        name: 'EstimatedUsdYoungAccounts',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
      {
        namespace: 'bike4mind/production/Turnstile',
        name: 'TurnstileMisconfigured',
        dimensions: undefined,
        stat: 'Sum',
        period: 300,
      },
    ]);
  });

  it('reports a metric whose query was refused as null and names it', async () => {
    cloudWatchMock.on(GetMetricDataCommand).callsFake((input: GetMetricDataCommandInput) => {
      const response = metricDataResponse(input);
      if (input.MetricDataQueries?.[0]?.Id !== 'm0') return response;
      return {
        MetricDataResults: response.MetricDataResults.map(result =>
          result.Id === 'm4' ? { Id: 'm4', StatusCode: 'Forbidden' } : result
        ),
      };
    });

    const { metrics } = await getIncidentSignals('1h');

    expect(metrics.oauthSignupsRefused).toBeNull();
    expect(metrics.signupCodeSends).toBe(25);
    expect(metrics.error).toContain('oauthSignupsRefused');
  });

  it('reuses the WAF traffic totals', async () => {
    const { waf } = await getIncidentSignals('24h');
    expect(waf).toEqual({ allowed: 900, blocked: 80, counted: 20 });
  });

  it('lists alarms across pages and strips the stage prefix', async () => {
    const { alarms } = await getIncidentSignals('24h');

    expect(alarms).toEqual({
      total: 4,
      inAlarm: [
        { name: 'young-account-spend-rate', since: '2026-11-02T11:00:00.000Z' },
        { name: 'signup-code-send-burst', since: '2026-11-02T10:00:00.000Z' },
      ],
    });
    const calls = cloudWatchMock.commandCalls(DescribeAlarmsCommand).map(call => call.args[0].input);
    expect(calls).toHaveLength(2);
    expect(calls[0].AlarmNamePrefix).toBe('bike4mind-production-');
    expect(calls[1].NextToken).toBe('page-2');
  });

  it('reports IP set sizes with the referencing action and never the addresses', async () => {
    const result = await getIncidentSignals('24h');

    expect(result.blockLists.lists).toEqual([
      { name: 'emergency-set', entries: 1, action: 'block' },
      { name: 'runtime-set', entries: 3, action: 'block' },
      { name: 'watch-set', entries: 2, action: 'count' },
      { name: 'exempt-set', entries: 1, action: 'other' },
    ]);
    expect(result.blockLists.error).toBeUndefined();
    const body = JSON.stringify(result);
    for (const address of Object.values(ADDRESSES).flat()) expect(body).not.toContain(address);
    expect(body).not.toContain('arn:');
    expect(wafMock.commandCalls(GetWebACLCommand)[0].args[0].input).toEqual({
      Name: 'test-acl',
      Id: 'acl-id',
      Scope: 'CLOUDFRONT',
    });
  });

  it('reads the runtime blocker from its single-dimension series', async () => {
    const { blockLists } = await getIncidentSignals('24h');

    expect(blockLists.blockerActiveEntries?.value).toBe(42);
    expect(Date.parse(blockLists.blockerActiveEntries?.at ?? '')).toBeGreaterThan(Date.now() - 6 * 60_000);
    const blockerQuery = cloudWatchMock
      .commandCalls(GetMetricDataCommand)
      .map(call => call.args[0].input)
      .find(input => input.MetricDataQueries?.[0]?.Id === 'blocker');
    expect(blockerQuery?.MetricDataQueries?.[0]?.MetricStat).toEqual({
      Metric: {
        Namespace: 'WafRuntimeBlocker',
        MetricName: 'ActiveEntries',
        Dimensions: [{ Name: 'Function', Value: 'runtime-blocker-prod' }],
      },
      Period: 300,
      Stat: 'Maximum',
    });
  });

  it('keeps every other section when one AWS call fails', async () => {
    cloudWatchMock.on(DescribeAlarmsCommand).rejects(new Error(`AccessDenied on ${ACL_ARN}`));
    wafMock.on(GetWebACLCommand).rejects(new Error(`AccessDenied on ${ACL_ARN}`));

    const result = await getIncidentSignals('24h');

    expect(result.alarms).toEqual({ total: null, inAlarm: [], error: 'Alarms could not be read' });
    expect(result.blockLists.lists).toEqual([]);
    expect(result.blockLists.error).toBe('WAF IP sets could not be read');
    expect(result.blockLists.blockerActiveEntries?.value).toBe(42);
    expect(result.metrics.signupCodeSends).toBe(25);
    expect(result.waf.allowed).toBe(900);
    expect(JSON.stringify(result)).not.toContain('arn:');
  });

  it('returns null metrics and WAF totals when CloudWatch fails outright', async () => {
    cloudWatchMock.on(GetMetricDataCommand).rejects(new Error('Throttling'));

    const result = await getIncidentSignals('7d');

    expect(result.metrics.successfulSignups).toBeNull();
    expect(result.metrics.error).toBe('CloudWatch metrics could not be read');
    expect(result.waf).toEqual({ allowed: null, blocked: null, counted: null, error: 'WAF traffic could not be read' });
    expect(result.alarms.total).toBe(4);
  });

  it('also lists alarms in us-east-1 when the default region differs, and merges them', async () => {
    process.env.AWS_REGION = 'us-east-2';
    cloudWatchMock
      .on(DescribeAlarmsCommand)
      .resolvesOnce({
        MetricAlarms: [{ AlarmName: 'bike4mind-production-api-burst', StateValue: 'OK' }],
      })
      .resolvesOnce({
        MetricAlarms: [
          {
            AlarmName: 'bike4mind-production-waf-otc-edge-signal-rate',
            StateValue: 'ALARM',
            StateTransitionedTimestamp: new Date('2026-11-02T12:00:00Z'),
          },
        ],
      });

    const { alarms } = await getIncidentSignals('24h');

    expect(alarms).toEqual({
      total: 2,
      inAlarm: [{ name: 'waf-otc-edge-signal-rate', since: '2026-11-02T12:00:00.000Z' }],
    });
    const regions = await Promise.all(
      cloudWatchMock.commandCalls(DescribeAlarmsCommand).map(call => call.thisValue.config.region())
    );
    expect(regions.sort()).toEqual(['us-east-1', 'us-east-2']);
  });

  it('keeps the data from one region and flags the section when the other fails', async () => {
    process.env.AWS_REGION = 'us-east-2';
    cloudWatchMock
      .on(DescribeAlarmsCommand)
      .resolvesOnce({ MetricAlarms: [{ AlarmName: 'bike4mind-production-api-burst', StateValue: 'OK' }] })
      .rejectsOnce(new Error('Throttling'));

    const { alarms } = await getIncidentSignals('24h');

    expect(alarms).toEqual({ total: 1, inAlarm: [], error: 'Alarms could not be read in every region' });
  });

  it('stops paging alarms at the page limit and reports it', async () => {
    cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [], NextToken: 'again' });

    const { alarms } = await getIncidentSignals('24h');

    expect(cloudWatchMock.commandCalls(DescribeAlarmsCommand)).toHaveLength(20);
    expect(alarms.error).toBe('Alarm listing returned too many pages');
  });

  it('stops paging metric data at the page limit and reports it', async () => {
    cloudWatchMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [], NextToken: 'again' });

    const { metrics } = await getIncidentSignals('24h');

    expect(metrics.error).toBe('CloudWatch metrics returned too many pages');
    expect(metrics.successfulSignups).toBeNull();
  });

  it('stops paging the blocker series list at the page limit and reports it', async () => {
    cloudWatchMock.on(ListMetricsCommand).resolves({ Metrics: [], NextToken: 'again' });

    const { blockLists } = await getIncidentSignals('24h');

    expect(cloudWatchMock.commandCalls(ListMetricsCommand)).toHaveLength(20);
    expect(blockLists.error).toContain('Runtime blocker metric returned too many pages');
  });

  it('reports a stage without a router WAF as not configured rather than failed', async () => {
    cloudFrontMock
      .on(GetDistributionCommand)
      .resolves({ Distribution: { DistributionConfig: { WebACLId: '' } } } as never);

    const { waf, blockLists } = await getIncidentSignals('24h');

    expect(waf).toEqual({ allowed: null, blocked: null, counted: null, notConfigured: true });
    expect(blockLists.notConfigured).toBe(true);
    expect(blockLists.lists).toEqual([]);
    expect(blockLists.error).toBeUndefined();
  });

  describe('cache lifetime', () => {
    const healthyFetches = () => cloudWatchMock.commandCalls(DescribeAlarmsCommand).length;

    it('refetches a degraded response after the short TTL', async () => {
      vi.useFakeTimers();
      cloudWatchMock.on(DescribeAlarmsCommand).rejects(new Error('Throttling'));

      await getIncidentSignals('24h');
      const initial = healthyFetches();
      await vi.advanceTimersByTimeAsync(WAF_CACHE_TTL.incidentDegraded - 1);
      await getIncidentSignals('24h');
      expect(healthyFetches()).toBe(initial);

      await vi.advanceTimersByTimeAsync(2);
      await getIncidentSignals('24h');
      expect(healthyFetches()).toBeGreaterThan(initial);
    });

    it('keeps a healthy response past the short TTL but refetches after the long one', async () => {
      vi.useFakeTimers();
      cloudWatchMock.on(DescribeAlarmsCommand).resolves({ MetricAlarms: [] });

      await getIncidentSignals('24h');
      const initial = healthyFetches();
      await vi.advanceTimersByTimeAsync(WAF_CACHE_TTL.incidentDegraded + 1);
      await getIncidentSignals('24h');
      expect(healthyFetches()).toBe(initial);

      await vi.advanceTimersByTimeAsync(WAF_CACHE_TTL.incident);
      await getIncidentSignals('24h');
      expect(healthyFetches()).toBeGreaterThan(initial);
    });
  });

  it('caches per range and shares one in-flight fetch', async () => {
    const [first, second] = await Promise.all([getIncidentSignals('24h'), getIncidentSignals('24h')]);
    await getIncidentSignals('24h');

    expect(second).toBe(first);
    expect(cloudWatchMock.commandCalls(DescribeAlarmsCommand)).toHaveLength(2);
    await getIncidentSignals('1h');
    expect(cloudWatchMock.commandCalls(DescribeAlarmsCommand)).toHaveLength(3);
  });
});

describe('ipSetActions', () => {
  it('walks nested statements and keeps the strongest action per set', () => {
    const actions = ipSetActions([
      ...rules,
      {
        Name: 'group',
        Priority: 4,
        OverrideAction: { None: {} },
        Statement: {
          ManagedRuleGroupStatement: {
            VendorName: 'AWS',
            Name: 'Common',
            ScopeDownStatement: { IPSetReferenceStatement: { ARN: ipSetArn('scoped-set') } },
          },
        },
        VisibilityConfig: undefined,
      } as Rule,
      {
        Name: 'watch-again',
        Priority: 5,
        Action: { Block: {} },
        Statement: { IPSetReferenceStatement: { ARN: ipSetArn('watch-set') } },
        VisibilityConfig: undefined,
      } as Rule,
    ]);

    expect(Object.fromEntries(actions)).toEqual({
      [ipSetArn('emergency-set')]: 'block',
      [ipSetArn('runtime-set')]: 'block',
      [ipSetArn('watch-set')]: 'block',
      [ipSetArn('exempt-set')]: 'other',
      [ipSetArn('scoped-set')]: 'other',
    });
  });

  it('treats a set under Not as indirect', () => {
    expect(
      collectIpSetRefs({
        NotStatement: { Statement: { IPSetReferenceStatement: { ARN: 'a', IPSetForwardedIPConfig: undefined } } },
      })
    ).toEqual([{ arn: 'a', direct: false }]);
  });
});

describe('pickBlockerFunction', () => {
  it('takes the only function, or the one naming the stage', () => {
    expect(pickBlockerFunction(['blocker-a', 'blocker-a'], 'production')).toBe('blocker-a');
    expect(pickBlockerFunction(['blocker-dev', 'blocker-prod'], 'production')).toBe('blocker-prod');
    expect(pickBlockerFunction(['blocker-dev', 'blocker-prod'], 'dev')).toBe('blocker-dev');
  });

  it('declines to guess between several unmatched functions', () => {
    expect(pickBlockerFunction(['blocker-a', 'blocker-b'], 'pr123')).toBeNull();
  });
});

describe('incidentMetricSpecs', () => {
  it('names the OAuth refusal metric exactly as the infra emitter does', () => {
    for (const stage of ['production', 'dev', 'pr-123']) {
      const spec = incidentMetricSpecs('bike4mind', stage).find(item => item.key === 'oauthSignupsRefused');
      expect(spec?.metricName).toBe(oauthSignupsRefusedMetricName(stage));
    }
  });
});

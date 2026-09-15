import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { CloudWatchClient, GetMetricDataCommand, ListMetricsCommand } from '@aws-sdk/client-cloudwatch';
import { BadRequestError } from '@server/utils/errors';
import {
  parseWebAclNameFromArn,
  rangeToCacheSegment,
  resolveRouterDistributionId,
  resolveTimeWindow,
  type WafCustomRange,
  type WafRangeInput,
  type WafTrafficRange,
} from './wafSharedHelpers';
import { WAF_CACHE_TTL, wafQueryCache } from './wafQueryCache';

export type { WafCustomRange, WafRangeInput, WafTrafficRange };
export type WafTrafficPeriod = '1m' | '5m' | '1h';

export interface WafTrafficTotals {
  allowed: number;
  blocked: number;
  counted: number;
  captcha?: number;
  challenge?: number;
  blockRate: number; // 0..1
}

export interface WafTrafficSeries {
  timestamps: string[]; // ISO strings
  allowed: number[];
  blocked: number[];
  counted: number[];
  captcha?: number[];
  challenge?: number[];
}

export interface WafTopBlockedRule {
  ruleName: string;
  blocked: number;
}

export interface WafTopBlockedRulesSeries {
  timestamps: string[]; // ISO strings
  series: Array<{
    ruleName: string;
    blocked: number[];
  }>;
}

export interface WafTrafficOverview {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  period: WafTrafficPeriod;
  checkedAt: string;
  distributionId?: string;
  webAclArn?: string;
  totals?: WafTrafficTotals;
  series?: WafTrafficSeries;
  topBlockedRules?: WafTopBlockedRule[];
  topBlockedRulesSeries?: WafTopBlockedRulesSeries;
  debug?: Record<string, unknown>;
}

const PERIOD_SECONDS: Record<WafTrafficPeriod, number> = {
  '1m': 60,
  '5m': 5 * 60,
  '1h': 60 * 60,
};

export function resolveDefaultPeriod(range: WafRangeInput): WafTrafficPeriod {
  if (typeof range === 'object') {
    const durationMs = new Date(range.end).getTime() - new Date(range.start).getTime();
    if (durationMs <= 2 * 60 * 60 * 1000) return '1m';
    if (durationMs <= 48 * 60 * 60 * 1000) return '5m';
    return '1h';
  }
  if (range === '1h') return '1m';
  if (range === '24h') return '5m';
  return '1h';
}

function unionTimestampsToSeries(results: Array<{ id: string; timestamps?: Date[]; values?: number[] }>): {
  timestamps: string[];
  valuesById: Record<string, number[]>;
} {
  const timestampSet = new Set<number>();
  const maps: Record<string, Map<number, number>> = {};

  for (const r of results) {
    const ts = r.timestamps ?? [];
    const vals = r.values ?? [];
    const map = new Map<number, number>();
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i]?.getTime();
      const v = vals[i];
      if (typeof t !== 'number' || typeof v !== 'number') continue;
      timestampSet.add(t);
      map.set(t, v);
    }
    maps[r.id] = map;
  }

  const timestampsSorted = Array.from(timestampSet).sort((a, b) => a - b);
  const timestamps = timestampsSorted.map(t => new Date(t).toISOString());

  const valuesById: Record<string, number[]> = {};
  for (const [id, map] of Object.entries(maps)) {
    valuesById[id] = timestampsSorted.map(t => map.get(t) ?? 0);
  }

  return { timestamps, valuesById };
}

async function getTrafficMetricsForWebAcl(params: {
  webAclArn: string;
  range: WafRangeInput;
  period: WafTrafficPeriod;
  debug?: boolean;
}): Promise<{ totals: WafTrafficTotals; series: WafTrafficSeries; debug?: Record<string, unknown> }> {
  const webAclName = parseWebAclNameFromArn(params.webAclArn);
  if (!webAclName) {
    throw new BadRequestError('Unable to parse WebACL name from CloudFront WebACLId ARN.');
  }

  // WAFv2 metrics for CLOUDFRONT scope are in us-east-1.
  const cloudwatch = new CloudWatchClient({ region: 'us-east-1' });

  const { startTime, endTime } = resolveTimeWindow(params.range);
  const periodSeconds = PERIOD_SECONDS[params.period];

  const safeWebAclName = webAclName.replace(/"/g, '\\"');

  const metricNames = [
    { id: 'allowed', metricName: 'AllowedRequests' },
    { id: 'blocked', metricName: 'BlockedRequests' },
    { id: 'counted', metricName: 'CountedRequests' },
    { id: 'captcha', metricName: 'CaptchaRequests' },
    { id: 'challenge', metricName: 'ChallengeRequests' },
  ] as const;

  const buildSearchExpr = (metricName: string, preferRuleAll: boolean) => {
    if (preferRuleAll) {
      // Prefer the "Rule=ALL" aggregate when it exists (matches AWS console view).
      return `SUM(SEARCH('{AWS/WAFV2,WebACL,Rule} MetricName="${metricName}" AND WebACL="${safeWebAclName}" AND Rule="ALL"', 'Sum', ${periodSeconds}))`;
    }
    // Fallback for accounts where WebACL-level totals omit Rule dimension.
    return `SUM(SEARCH('{AWS/WAFV2,WebACL} MetricName="${metricName}" AND WebACL="${safeWebAclName}"', 'Sum', ${periodSeconds}))`;
  };

  const metricQueries = metricNames.flatMap(m => [
    {
      Id: `${m.id}A`,
      ReturnData: true,
      Expression: buildSearchExpr(m.metricName, true),
      Label: `${m.metricName} (Rule=ALL)`,
    },
    {
      Id: `${m.id}B`,
      ReturnData: true,
      Expression: buildSearchExpr(m.metricName, false),
      Label: `${m.metricName} (no Rule)`,
    },
  ]);

  const response = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: metricQueries,
    })
  );

  const results = response.MetricDataResults ?? [];
  const sumVals = (arr?: number[]) => (arr ?? []).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);

  const pick = (a?: { Timestamps?: Date[]; Values?: number[] }, b?: { Timestamps?: Date[]; Values?: number[] }) => {
    const aPoints = a?.Timestamps?.length ?? 0;
    const bPoints = b?.Timestamps?.length ?? 0;
    const aSum = sumVals(a?.Values);
    const bSum = sumVals(b?.Values);
    if (aPoints === 0 && bPoints === 0)
      return { chosen: 'none' as const, data: undefined, a: { aPoints, aSum }, b: { bPoints, bSum } };
    if (aPoints > 0 && bPoints === 0)
      return { chosen: 'A' as const, data: a, a: { aPoints, aSum }, b: { bPoints, bSum } };
    if (bPoints > 0 && aPoints === 0)
      return { chosen: 'B' as const, data: b, a: { aPoints, aSum }, b: { bPoints, bSum } };
    // Both exist: choose higher sum; tie-breaker prefers Rule=ALL (A).
    if (bSum > aSum) return { chosen: 'B' as const, data: b, a: { aPoints, aSum }, b: { bPoints, bSum } };
    return { chosen: 'A' as const, data: a, a: { aPoints, aSum }, b: { bPoints, bSum } };
  };

  const getById = (id: string) => results.find(r => r.Id === id);

  const picked = {
    allowed: pick(getById('allowedA'), getById('allowedB')),
    blocked: pick(getById('blockedA'), getById('blockedB')),
    counted: pick(getById('countedA'), getById('countedB')),
    captcha: pick(getById('captchaA'), getById('captchaB')),
    challenge: pick(getById('challengeA'), getById('challengeB')),
  };

  const normalized = [
    { id: 'allowed', timestamps: picked.allowed.data?.Timestamps, values: picked.allowed.data?.Values },
    { id: 'blocked', timestamps: picked.blocked.data?.Timestamps, values: picked.blocked.data?.Values },
    { id: 'counted', timestamps: picked.counted.data?.Timestamps, values: picked.counted.data?.Values },
    { id: 'captcha', timestamps: picked.captcha.data?.Timestamps, values: picked.captcha.data?.Values },
    { id: 'challenge', timestamps: picked.challenge.data?.Timestamps, values: picked.challenge.data?.Values },
  ];

  const { timestamps, valuesById } = unionTimestampsToSeries(normalized);

  const allowedSeries = valuesById.allowed ?? new Array(timestamps.length).fill(0);
  const blockedSeries = valuesById.blocked ?? new Array(timestamps.length).fill(0);
  const countedSeries = valuesById.counted ?? new Array(timestamps.length).fill(0);
  const captchaSeries = valuesById.captcha ?? new Array(timestamps.length).fill(0);
  const challengeSeries = valuesById.challenge ?? new Array(timestamps.length).fill(0);

  const sum = (arr: number[]) => arr.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  const allowed = sum(allowedSeries);
  const blocked = sum(blockedSeries);
  const counted = sum(countedSeries);
  const captcha = sum(captchaSeries);
  const challenge = sum(challengeSeries);

  // Align closer to AWS console "Action totals": total actions can include captcha/challenge.
  const totalObserved = allowed + blocked + counted + captcha + challenge;
  const blockRate = totalObserved > 0 ? blocked / totalObserved : 0;

  return {
    totals: { allowed, blocked, counted, captcha, challenge, blockRate },
    series: {
      timestamps,
      allowed: allowedSeries,
      blocked: blockedSeries,
      counted: countedSeries,
      captcha: captchaSeries,
      challenge: challengeSeries,
    },
    ...(params.debug
      ? {
          debug: {
            webAclName,
            picked,
            metricResults: (response.MetricDataResults ?? []).map(r => ({
              id: r.Id,
              points: r.Timestamps?.length ?? 0,
              status: r.StatusCode,
              message: r.Messages?.[0],
            })),
          },
        }
      : {}),
  };
}

async function getTopBlockedRules(params: {
  webAclArn: string;
  range: WafRangeInput;
  period: WafTrafficPeriod;
  maxRules?: number;
}): Promise<{ topBlockedRules: WafTopBlockedRule[]; topBlockedRulesSeries: WafTopBlockedRulesSeries | null }> {
  const webAclName = parseWebAclNameFromArn(params.webAclArn);
  if (!webAclName) return { topBlockedRules: [], topBlockedRulesSeries: null };

  const cloudwatch = new CloudWatchClient({ region: 'us-east-1' });
  const { startTime, endTime } = resolveTimeWindow(params.range);
  const periodSeconds = PERIOD_SECONDS[params.period];

  // Discover the region dimension value (if present) to ensure per-rule queries match published metrics.
  const baseMetricList = await cloudwatch.send(
    new ListMetricsCommand({
      Namespace: 'AWS/WAFV2',
      MetricName: 'BlockedRequests',
      Dimensions: [{ Name: 'WebACL', Value: webAclName }],
    })
  );

  const regionValue =
    (baseMetricList.Metrics ?? [])
      .flatMap(m => m.Dimensions ?? [])
      .find(d => d.Name === 'Region' && typeof d.Value === 'string')?.Value || null;

  const list = await cloudwatch.send(
    new ListMetricsCommand({
      Namespace: 'AWS/WAFV2',
      MetricName: 'BlockedRequests',
      Dimensions: [
        { Name: 'WebACL', Value: webAclName },
        ...(regionValue ? [{ Name: 'Region', Value: regionValue }] : []),
      ],
    })
  );

  const rules = new Set<string>();
  for (const m of list.Metrics ?? []) {
    const dims = m.Dimensions ?? [];
    const ruleDim = dims.find(d => d.Name === 'Rule');
    if (ruleDim?.Value && ruleDim.Value !== 'ALL') {
      rules.add(ruleDim.Value);
    }
  }

  const ruleNames = Array.from(rules).slice(0, params.maxRules ?? 50);
  if (ruleNames.length === 0) return { topBlockedRules: [], topBlockedRulesSeries: null };

  const queries = ruleNames.map((ruleName, idx) => ({
    Id: `r${idx}`,
    ReturnData: true,
    MetricStat: {
      Metric: {
        Namespace: 'AWS/WAFV2',
        MetricName: 'BlockedRequests',
        Dimensions: [
          { Name: 'WebACL', Value: webAclName },
          { Name: 'Rule', Value: ruleName },
          ...(regionValue ? [{ Name: 'Region', Value: regionValue }] : []),
        ],
      },
      Period: periodSeconds,
      Stat: 'Sum',
    },
  }));

  const response = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: queries,
    })
  );

  const sum = (arr?: number[]) => (arr ?? []).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
  const ruleSeries = (response.MetricDataResults ?? [])
    .map(r => {
      const idx = r.Id?.startsWith('r') ? Number(r.Id.slice(1)) : -1;
      const ruleName = idx >= 0 ? ruleNames[idx] : undefined;
      if (!ruleName) return null;
      return {
        ruleName,
        blocked: sum(r.Values),
        timestamps: r.Timestamps,
        values: r.Values,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  const top = ruleSeries
    .filter(r => r.blocked > 0)
    .sort((a, b) => b.blocked - a.blocked)
    .slice(0, 10);

  const topBlockedRules = top.map(r => ({ ruleName: r.ruleName, blocked: r.blocked }));

  if (top.length === 0) {
    return { topBlockedRules, topBlockedRulesSeries: null };
  }

  const { timestamps, valuesById } = unionTimestampsToSeries(
    top.map(r => ({ id: r.ruleName, timestamps: r.timestamps, values: r.values }))
  );

  const topBlockedRulesSeries: WafTopBlockedRulesSeries = {
    timestamps,
    series: top.map(r => ({
      ruleName: r.ruleName,
      blocked: valuesById[r.ruleName] ?? new Array(timestamps.length).fill(0),
    })),
  };

  return { topBlockedRules, topBlockedRulesSeries };
}

export async function getWafTrafficOverview(params: {
  stage: string;
  range: WafRangeInput;
  period: WafTrafficPeriod;
  includeRules?: boolean;
  debug?: boolean;
}): Promise<WafTrafficOverview> {
  // Bypass cache when debug mode is requested - always return fresh data for diagnostics.
  if (params.debug) return fetchWafTrafficOverview(params);
  const cacheKey = `waf-traffic#${params.stage}#${rangeToCacheSegment(params.range)}#${params.period}#${params.includeRules ?? false}`;
  return wafQueryCache.getOrFetch(cacheKey, WAF_CACHE_TTL.traffic, () => fetchWafTrafficOverview(params));
}

async function fetchWafTrafficOverview(params: {
  stage: string;
  range: WafRangeInput;
  period: WafTrafficPeriod;
  includeRules?: boolean;
  debug?: boolean;
}): Promise<WafTrafficOverview> {
  const checkedAt = new Date().toISOString();
  const distributionId = resolveRouterDistributionId();

  // CloudFront is global, so we do not set a region.
  const cloudfront = new CloudFrontClient({});
  const dist = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
  const webAclArn = dist.Distribution?.DistributionConfig?.WebACLId || '';

  if (!webAclArn) {
    return {
      enabled: false,
      stage: params.stage,
      range: params.range,
      period: params.period,
      checkedAt,
      distributionId,
    };
  }

  const { totals, series, debug } = await getTrafficMetricsForWebAcl({
    webAclArn,
    range: params.range,
    period: params.period,
    debug: params.debug,
  });

  const rulesData = params.includeRules
    ? await getTopBlockedRules({ webAclArn, range: params.range, period: params.period })
    : null;

  return {
    enabled: true,
    stage: params.stage,
    range: params.range,
    period: params.period,
    checkedAt,
    distributionId,
    webAclArn,
    totals,
    series,
    ...(rulesData?.topBlockedRules ? { topBlockedRules: rulesData.topBlockedRules } : {}),
    ...(rulesData?.topBlockedRulesSeries ? { topBlockedRulesSeries: rulesData.topBlockedRulesSeries } : {}),
    ...(debug ? { debug } : {}),
  };
}

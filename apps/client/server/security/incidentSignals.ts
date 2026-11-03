import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  ListMetricsCommand,
  type MetricDataQuery,
  type MetricDataResult,
} from '@aws-sdk/client-cloudwatch';
import { GetIPSetCommand, GetWebACLCommand, WAFV2Client, type Rule, type Statement } from '@aws-sdk/client-wafv2';
import { Logger } from '@bike4mind/observability';
import { RANGE_MS } from '@bike4mind/server-utils/security/wafSharedHelpers';
import { resolveStage } from '@bike4mind/server-utils/security/resolveStage';
import { Resource } from 'sst';
import type {
  IncidentAlarm,
  IncidentAlarms,
  IncidentBlockList,
  IncidentBlockListAction,
  IncidentBlockLists,
  IncidentMetricTotals,
  IncidentRange,
  IncidentSignals,
  IncidentWafTotals,
} from '@client/app/components/admin/SecurityDashboard/incidentTypes';
import { getWafTrafficOverview, resolveDefaultPeriod, resolveRouterWebAcl } from './wafTraffic';
import { WAF_CACHE_TTL, wafQueryCache } from './wafQueryCache';

const HOUR_MS = 60 * 60 * 1000;

// Bounds every NextToken loop so a misbehaving API cannot spin a request forever.
const MAX_PAGES = 20;

class PageLimitError extends Error {
  constructor(what: string) {
    super(`${what} exceeded ${MAX_PAGES} pages`);
    this.name = 'PageLimitError';
  }
}

// WAF alarms are created next to the CLOUDFRONT-scope WAF, in us-east-1.
const WAF_ALARM_REGION = 'us-east-1';

type MetricKey = Exclude<keyof IncidentMetricTotals, 'error'>;

interface MetricSpec {
  key: MetricKey;
  namespace: string;
  metricName: string;
  stat: 'Sum' | 'Maximum';
  hourly?: boolean;
}

// Namespaces and names must stay in sync with their emitters: infra/accountCreationAlarms.ts and
// apps/workers/src/cron/accountCreationMetrics.ts (AccountCreation), infra/signupAlarms.ts (Signup),
// infra/authAbuseAlarms.ts + infra/authAbuseMetric.ts (OAuth), infra/llmSpend.ts (LLMSpend) and
// infra/turnstileAlarms.ts (Turnstile). None of them publish dimensions.
export function incidentMetricSpecs(app: string, stage: string): MetricSpec[] {
  const ns = (suffix: string) => `${app}/${stage}/${suffix}`;
  return [
    // The census writes one Maximum-idempotent datapoint per completed hour.
    {
      key: 'successfulSignups',
      namespace: ns('AccountCreation'),
      metricName: 'SuccessfulSignups',
      stat: 'Maximum',
      hourly: true,
    },
    { key: 'fullGrants', namespace: ns('Signup'), metricName: 'SignupGrant_full', stat: 'Sum' },
    { key: 'signupCodeSends', namespace: ns('Signup'), metricName: 'SignupCodeSends', stat: 'Sum' },
    { key: 'apiKeyCreations', namespace: ns('Signup'), metricName: 'ApiKeyCreations', stat: 'Sum' },
    {
      key: 'oauthSignupsRefused',
      namespace: 'Lumina5/AuthSecurity',
      // Mirrors oauthSignupsRefusedMetricName in infra/authAbuseMetric.ts (pinned by a test).
      metricName: stage === 'production' ? 'OAuthSignupsRefused' : `OAuthSignupsRefused-${stage}`,
      stat: 'Sum',
    },
    { key: 'youngAccountSpendUsd', namespace: ns('LLMSpend'), metricName: 'EstimatedUsdYoungAccounts', stat: 'Sum' },
    { key: 'turnstileMisconfigured', namespace: ns('Turnstile'), metricName: 'TurnstileMisconfigured', stat: 'Sum' },
  ];
}

const sum = (values: number[] | undefined) => (values ?? []).reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);

async function getMetricDataPages(
  client: CloudWatchClient,
  input: { StartTime: Date; EndTime: Date; MetricDataQueries: MetricDataQuery[]; ScanBy?: 'TimestampDescending' }
): Promise<Map<string, MetricDataResult>> {
  const byId = new Map<string, MetricDataResult>();
  let NextToken: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new PageLimitError('GetMetricData');
    const page = await client.send(new GetMetricDataCommand({ ...input, NextToken }));
    for (const result of page.MetricDataResults ?? []) {
      if (!result.Id) continue;
      const prior = byId.get(result.Id);
      byId.set(
        result.Id,
        prior
          ? {
              ...result,
              Values: [...(prior.Values ?? []), ...(result.Values ?? [])],
              Timestamps: [...(prior.Timestamps ?? []), ...(result.Timestamps ?? [])],
            }
          : result
      );
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return byId;
}

async function getMetricTotals(app: string, stage: string, range: IncidentRange): Promise<IncidentMetricTotals> {
  const specs = incidentMetricSpecs(app, stage);
  const nulls = Object.fromEntries(specs.map(spec => [spec.key, null])) as Record<MetricKey, null>;
  try {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - RANGE_MS[range]);
    // Census datapoints are stamped at the start of their hour; widen to that hour so it is counted.
    const hourlyStart = new Date(Math.floor(startTime.getTime() / HOUR_MS) * HOUR_MS);
    const period = range === '7d' ? 3600 : 300;
    const queries: MetricDataQuery[] = specs.map((spec, index) => ({
      Id: `m${index}`,
      ReturnData: true,
      MetricStat: {
        Metric: { Namespace: spec.namespace, MetricName: spec.metricName },
        Period: spec.hourly ? 3600 : period,
        Stat: spec.stat,
      },
    }));
    const client = new CloudWatchClient({});
    const results = await getMetricDataPages(client, {
      StartTime: hourlyStart,
      EndTime: endTime,
      MetricDataQueries: queries,
    });
    const totals: Record<MetricKey, number | null> = { ...nulls };
    const failed: string[] = [];
    specs.forEach((spec, index) => {
      const result = results.get(`m${index}`);
      if (!result || result.StatusCode === 'InternalError' || result.StatusCode === 'Forbidden') {
        failed.push(spec.key);
        return;
      }
      const cutoff = spec.hourly ? hourlyStart.getTime() : startTime.getTime();
      const values = (result.Values ?? []).filter((_, i) => (result.Timestamps?.[i]?.getTime() ?? 0) >= cutoff);
      totals[spec.key] = sum(values);
    });
    return failed.length > 0 ? { ...totals, error: `Some metrics could not be read: ${failed.join(', ')}` } : totals;
  } catch (error) {
    Logger.globalInstance.warn('Incident signals: metric query failed', { error });
    return {
      ...nulls,
      error:
        error instanceof PageLimitError
          ? 'CloudWatch metrics returned too many pages'
          : 'CloudWatch metrics could not be read',
    };
  }
}

async function getWafTotals(stage: string, range: IncidentRange): Promise<IncidentWafTotals> {
  const nulls = { allowed: null, blocked: null, counted: null };
  try {
    // The totals come from the shared traffic overview, so they can lag by WAF_CACHE_TTL.traffic.
    const overview = await getWafTrafficOverview({ stage, range, period: resolveDefaultPeriod(range) });
    if (!overview.enabled) return { ...nulls, notConfigured: true };
    if (!overview.totals) return { ...nulls, error: 'WAF traffic could not be read' };
    const { allowed, blocked, counted } = overview.totals;
    return { allowed, blocked, counted };
  } catch (error) {
    Logger.globalInstance.warn('Incident signals: WAF totals failed', { error });
    return { ...nulls, error: 'WAF traffic could not be read' };
  }
}

async function listAlarms(
  client: CloudWatchClient,
  prefix: string
): Promise<{ total: number; inAlarm: IncidentAlarm[] }> {
  let total = 0;
  const inAlarm: IncidentAlarm[] = [];
  let NextToken: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new PageLimitError('DescribeAlarms');
    const page = await client.send(
      new DescribeAlarmsCommand({
        AlarmNamePrefix: prefix,
        AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
        MaxRecords: 100,
        NextToken,
      })
    );
    const alarms = [...(page.MetricAlarms ?? []), ...(page.CompositeAlarms ?? [])];
    total += alarms.length;
    for (const alarm of alarms) {
      if (alarm.StateValue !== 'ALARM' || !alarm.AlarmName) continue;
      const since = alarm.StateTransitionedTimestamp ?? alarm.StateUpdatedTimestamp;
      inAlarm.push({
        name: alarm.AlarmName.startsWith(prefix) ? alarm.AlarmName.slice(prefix.length) : alarm.AlarmName,
        since: since ? since.toISOString() : new Date(0).toISOString(),
      });
    }
    NextToken = page.NextToken;
  } while (NextToken);
  return { total, inAlarm };
}

async function getAlarms(app: string, stage: string): Promise<IncidentAlarms> {
  // The prefix also matches a stage whose name starts with `${stage}-`; stage names are expected not to nest.
  const prefix = `${app}-${stage}-`;
  const defaultClient = new CloudWatchClient({});
  const defaultRegion = await defaultClient.config.region().catch(() => undefined);
  const clients =
    defaultRegion === WAF_ALARM_REGION
      ? [defaultClient]
      : [defaultClient, new CloudWatchClient({ region: WAF_ALARM_REGION })];

  const settled = await Promise.allSettled(clients.map(client => listAlarms(client, prefix)));
  const fulfilled = settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
  const failures = settled.flatMap(result => (result.status === 'rejected' ? [result.reason as unknown] : []));

  if (failures.length > 0) {
    Logger.globalInstance.warn('Incident signals: alarm listing failed', { errors: failures.map(String) });
  }
  const inAlarm = fulfilled.flatMap(result => result.inAlarm).sort((a, b) => b.since.localeCompare(a.since));
  const total = fulfilled.length > 0 ? fulfilled.reduce((acc, result) => acc + result.total, 0) : null;
  if (failures.length === 0) return { total, inAlarm };

  const error = failures.some(failure => failure instanceof PageLimitError)
    ? 'Alarm listing returned too many pages'
    : fulfilled.length > 0
      ? 'Alarms could not be read in every region'
      : 'Alarms could not be read';
  return { total, inAlarm, error };
}

const ACTION_RANK: Record<IncidentBlockListAction, number> = { block: 0, count: 1, other: 2 };

function ruleAction(rule: Rule): IncidentBlockListAction {
  if (rule.Action?.Block) return 'block';
  if (rule.Action?.Count) return 'count';
  return 'other';
}

/**
 * IP set ARNs referenced by a statement, each with whether it decides the rule's match directly.
 * A set under Not, or scoping a rate-based or managed rule group statement, is not a block list
 * even when the rule blocks (e.g. a rate-exempt set), so it is reported as `other`.
 */
export function collectIpSetRefs(
  statement: Statement | undefined,
  direct = true
): Array<{ arn: string; direct: boolean }> {
  if (!statement) return [];
  const refs: Array<{ arn: string; direct: boolean }> = [];
  if (statement.IPSetReferenceStatement?.ARN) refs.push({ arn: statement.IPSetReferenceStatement.ARN, direct });
  for (const child of statement.AndStatement?.Statements ?? []) refs.push(...collectIpSetRefs(child, direct));
  for (const child of statement.OrStatement?.Statements ?? []) refs.push(...collectIpSetRefs(child, direct));
  refs.push(...collectIpSetRefs(statement.NotStatement?.Statement, false));
  refs.push(...collectIpSetRefs(statement.RateBasedStatement?.ScopeDownStatement, false));
  refs.push(...collectIpSetRefs(statement.ManagedRuleGroupStatement?.ScopeDownStatement, false));
  return refs;
}

/** Best action per referenced IP set ARN across all rules of the ACL. */
export function ipSetActions(rules: Rule[]): Map<string, IncidentBlockListAction> {
  const actions = new Map<string, IncidentBlockListAction>();
  for (const rule of rules) {
    const action = ruleAction(rule);
    for (const ref of collectIpSetRefs(rule.Statement)) {
      const resolved: IncidentBlockListAction = ref.direct ? action : 'other';
      const prior = actions.get(ref.arn);
      if (!prior || ACTION_RANK[resolved] < ACTION_RANK[prior]) actions.set(ref.arn, resolved);
    }
  }
  return actions;
}

/** `<name>/<id>` after `/<kind>/` in a WAFv2 ARN. */
function parseWafArn(arn: string, kind: 'webacl' | 'ipset'): { name: string; id: string } | null {
  const marker = `/${kind}/`;
  const idx = arn.indexOf(marker);
  if (idx < 0) return null;
  const [name, id] = arn.slice(idx + marker.length).split('/');
  return name && id ? { name, id } : null;
}

async function getIpSetLists(): Promise<{ lists: IncidentBlockList[]; error?: string; notConfigured?: true }> {
  const { webAclArn } = await resolveRouterWebAcl();
  if (!webAclArn) return { lists: [], notConfigured: true };
  const acl = parseWafArn(webAclArn, 'webacl');
  if (!acl) return { lists: [], error: 'The router WebACL could not be identified' };

  // CLOUDFRONT-scope WAF resources are only reachable in us-east-1.
  const waf = new WAFV2Client({ region: 'us-east-1' });
  const { WebACL } = await waf.send(new GetWebACLCommand({ Name: acl.name, Id: acl.id, Scope: 'CLOUDFRONT' }));
  const actions = ipSetActions(WebACL?.Rules ?? []);

  const settled = await Promise.allSettled(
    [...actions.entries()].map(async ([arn, action]): Promise<IncidentBlockList> => {
      const ref = parseWafArn(arn, 'ipset');
      if (!ref) throw new Error('Unrecognized IP set reference');
      const { IPSet } = await waf.send(new GetIPSetCommand({ Name: ref.name, Id: ref.id, Scope: 'CLOUDFRONT' }));
      return { name: IPSet?.Name ?? ref.name, entries: IPSet?.Addresses?.length ?? 0, action };
    })
  );
  const lists = settled
    .flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
    .sort((a, b) => ACTION_RANK[a.action] - ACTION_RANK[b.action] || a.name.localeCompare(b.name));
  const failed = settled.length - lists.length;
  if (failed > 0) {
    Logger.globalInstance.warn('Incident signals: IP set read failed', {
      errors: settled.flatMap(result => (result.status === 'rejected' ? [String(result.reason)] : [])),
    });
    return { lists, error: `${failed} of ${settled.length} IP sets could not be read` };
  }
  return { lists };
}

/**
 * Picks the runtime blocker's ActiveEntries series. The blocker is deployed outside this repo, so its
 * function name is discovered: only single-dimension (Function) series count, and with several the
 * one naming this stage wins (or 'prod' on production).
 */
export function pickBlockerFunction(functionNames: string[], stage: string): string | null {
  const unique = [...new Set(functionNames)];
  if (unique.length === 1) return unique[0];
  const needle = stage.toLowerCase();
  const matches = unique.filter(name => {
    const lower = name.toLowerCase();
    return lower.includes(needle) || (stage === 'production' && lower.includes('prod'));
  });
  return matches.length === 1 ? matches[0] : null;
}

async function getBlockerActiveEntries(stage: string): Promise<{
  value: { value: number; at: string } | null;
  error?: string;
}> {
  // The blocker publishes next to the CLOUDFRONT-scope WAF in us-east-1.
  const client = new CloudWatchClient({ region: 'us-east-1' });
  const functionNames: string[] = [];
  let NextToken: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_PAGES) throw new PageLimitError('ListMetrics');
    const page = await client.send(
      new ListMetricsCommand({
        Namespace: 'WafRuntimeBlocker',
        MetricName: 'ActiveEntries',
        RecentlyActive: 'PT3H',
        NextToken,
      })
    );
    for (const metric of page.Metrics ?? []) {
      const dims = metric.Dimensions ?? [];
      if (dims.length === 1 && dims[0].Name === 'Function' && dims[0].Value) functionNames.push(dims[0].Value);
    }
    NextToken = page.NextToken;
  } while (NextToken);

  if (functionNames.length === 0) return { value: null };
  const functionName = pickBlockerFunction(functionNames, stage);
  if (!functionName) return { value: null, error: 'Several runtime blockers publish; none matches this stage' };

  const endTime = new Date();
  const results = await getMetricDataPages(client, {
    StartTime: new Date(endTime.getTime() - 2 * HOUR_MS),
    EndTime: endTime,
    ScanBy: 'TimestampDescending',
    MetricDataQueries: [
      {
        Id: 'blocker',
        ReturnData: true,
        MetricStat: {
          Metric: {
            Namespace: 'WafRuntimeBlocker',
            MetricName: 'ActiveEntries',
            Dimensions: [{ Name: 'Function', Value: functionName }],
          },
          Period: 300,
          Stat: 'Maximum',
        },
      },
    ],
  });
  const result = results.get('blocker');
  const points = (result?.Timestamps ?? [])
    .map((at, i) => ({ at, value: result?.Values?.[i] }))
    .filter((point): point is { at: Date; value: number } => typeof point.value === 'number')
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = points[0];
  return { value: latest ? { value: latest.value, at: latest.at.toISOString() } : null };
}

async function getBlockLists(stage: string): Promise<IncidentBlockLists> {
  const [lists, blocker] = await Promise.allSettled([getIpSetLists(), getBlockerActiveEntries(stage)]);
  const errors: string[] = [];
  let resolvedLists: IncidentBlockList[] = [];
  let notConfigured = false;
  if (lists.status === 'fulfilled') {
    resolvedLists = lists.value.lists;
    notConfigured = lists.value.notConfigured === true;
    if (lists.value.error) errors.push(lists.value.error);
  } else {
    Logger.globalInstance.warn('Incident signals: WebACL read failed', { error: lists.reason });
    errors.push('WAF IP sets could not be read');
  }
  let blockerActiveEntries: IncidentBlockLists['blockerActiveEntries'] = null;
  if (blocker.status === 'fulfilled') {
    blockerActiveEntries = blocker.value.value;
    if (blocker.value.error) errors.push(blocker.value.error);
  } else {
    Logger.globalInstance.warn('Incident signals: runtime blocker metric failed', { error: blocker.reason });
    errors.push(
      blocker.reason instanceof PageLimitError
        ? 'Runtime blocker metric returned too many pages'
        : 'Runtime blocker metric could not be read'
    );
  }
  return {
    lists: resolvedLists,
    blockerActiveEntries,
    ...(notConfigured ? { notConfigured: true as const } : {}),
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
}

function resolveAppName(): string {
  try {
    return Resource.App.name;
  } catch {
    return process.env.SST_APP || 'bike4mind';
  }
}

async function fetchIncidentSignals(range: IncidentRange): Promise<IncidentSignals> {
  const app = resolveAppName();
  const stage = resolveStage();
  const [metrics, waf, alarms, blockLists] = await Promise.all([
    getMetricTotals(app, stage, range),
    getWafTotals(stage, range),
    getAlarms(app, stage),
    getBlockLists(stage),
  ]);
  return { generatedAt: new Date().toISOString(), range, metrics, waf, alarms, blockLists };
}

const isDegraded = (signals: IncidentSignals) =>
  [signals.metrics, signals.waf, signals.alarms, signals.blockLists].some(section => section.error);

export function getIncidentSignals(range: IncidentRange): Promise<IncidentSignals> {
  return wafQueryCache.getOrFetch(
    `incident-signals#${range}`,
    signals => (isDegraded(signals) ? WAF_CACHE_TTL.incidentDegraded : WAF_CACHE_TTL.incident),
    () => fetchIncidentSignals(range)
  );
}

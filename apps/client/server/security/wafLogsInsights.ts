import { CloudFrontClient, GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { GetLoggingConfigurationCommand, WAFV2Client } from '@aws-sdk/client-wafv2';
import {
  parseIsoTimestamp,
  parseLogGroupInfoFromArn,
  rangeToCacheSegment,
  resolveRouterDistributionId,
  resolveTimeWindow,
  type WafRangeInput,
} from './wafSharedHelpers';
import { WAF_CACHE_TTL, wafQueryCache } from './wafQueryCache';

export interface WafLogsTopItem {
  name: string;
  count: number;
}

export interface WafRateLimitIpUsage {
  ip: string;
  uri: string;
  /** Highest request count for this IP+URI pair in any single 5-minute window within the queried range. */
  peakRequests: number;
}

export interface WafRateLimitUsage {
  /** Max requests per window per IP (from the api-rate-limit rule). */
  limitPerWindow: number;
  /** Rolling window size in seconds. */
  windowSecs: number;
  topIps: WafRateLimitIpUsage[];
}

export interface WafLogsInsightsOverview {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  checkedAt: string;
  webAclArn?: string;
  logGroupName?: string;
  logGroupRegion?: string;
  trafficCharacteristics?: {
    topBlockedUris: WafLogsTopItem[];
    topClientIps: WafLogsTopItem[];
  };
  managedRuleGroups?: {
    rateLimitUsage: WafRateLimitUsage;
  };
  reason?: 'no-webacl' | 'no-logging-config' | 'no-log-destination' | 'no-data';
  debug?: Record<string, unknown>;
}

/**
 * Max requests per 5-minute window per IP before the api-rate-limit rule triggers a BLOCK.
 * Must stay in sync with the EvaluationWindowSec: 300 / Limit: 10000 in the WAF policy.
 */
const RATE_LIMIT = 10_000;

/** Rolling window size in seconds - matches the WAF api-rate-limit rule's EvaluationWindowSec. */
const RATE_WINDOW_SECS = 300;

async function resolveRouterWebAclArn(): Promise<{ distributionId: string; webAclArn: string | null }> {
  const distributionId = resolveRouterDistributionId();
  const cloudfront = new CloudFrontClient({});
  const dist = await cloudfront.send(new GetDistributionCommand({ Id: distributionId }));
  const webAclArn = dist.Distribution?.DistributionConfig?.WebACLId || '';
  return { distributionId, webAclArn: webAclArn || null };
}

async function resolveWafLogGroupInfo(webAclArn: string): Promise<{ region: string; name: string } | null> {
  // WAFv2 CLOUDFRONT-scope APIs are in us-east-1.
  const waf = new WAFV2Client({ region: 'us-east-1' });
  try {
    const res = await waf.send(new GetLoggingConfigurationCommand({ ResourceArn: webAclArn }));
    const destinations = res.LoggingConfiguration?.LogDestinationConfigs ?? [];
    const first = destinations[0];
    if (!first) return null;
    return parseLogGroupInfoFromArn(first);
  } catch {
    return null;
  }
}

type InsightsRow = Record<string, string>;

function rowsToTopItems(rows: InsightsRow[], nameField: string, countField: string): WafLogsTopItem[] {
  return rows
    .map(r => {
      const name = (r[nameField] || '').trim();
      const raw = (r[countField] || '').trim();
      const count = Number(raw);
      if (!name || !Number.isFinite(count)) return null;
      return { name, count };
    })
    .filter((v): v is WafLogsTopItem => Boolean(v))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function runLogsInsightsQuery(params: {
  region: string;
  logGroupName: string;
  startTime: Date;
  endTime: Date;
  queryString: string;
  timeoutMs?: number;
  limit?: number;
}): Promise<{ rows: InsightsRow[]; debug: Record<string, unknown> }> {
  const client = new CloudWatchLogsClient({ region: params.region });

  const startTimeSeconds = Math.floor(params.startTime.getTime() / 1000);
  const endTimeSeconds = Math.floor(params.endTime.getTime() / 1000);

  const start = await client.send(
    new StartQueryCommand({
      logGroupNames: [params.logGroupName],
      startTime: startTimeSeconds,
      endTime: endTimeSeconds,
      queryString: params.queryString,
      limit: params.limit ?? 1000,
    })
  );

  const queryId = start.queryId;
  if (!queryId) {
    throw new Error('Failed to start CloudWatch Logs Insights query (missing queryId).');
  }

  // Logs Insights queries can take a while on high-volume log groups (especially over 24h/7d windows).
  // If we return early, the UI looks like "no data" even though AWS console has results.
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  let status = 'Unknown';
  type InsightsResultRow = Array<{ field?: string; value?: string }>;
  let lastResults: InsightsResultRow[] = [];

  while (Date.now() - startedAt < timeoutMs) {
    const res = await client.send(new GetQueryResultsCommand({ queryId }));
    status = res.status ?? 'Unknown';
    lastResults = res.results ?? [];
    if (status === 'Complete' || status === 'Cancelled' || status === 'Failed' || status === 'Timeout') {
      break;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  if (status !== 'Complete') {
    try {
      await client.send(new StopQueryCommand({ queryId }));
    } catch {
      // best-effort
    }
  }

  const rows: InsightsRow[] = (lastResults ?? []).map(cols => {
    const row: InsightsRow = {};
    for (const c of cols) {
      if (c.field && typeof c.value === 'string') row[c.field] = c.value;
    }
    return row;
  });

  return {
    rows,
    debug: {
      queryId,
      status,
      resultCount: rows.length,
      logGroupName: params.logGroupName,
      region: params.region,
      timeoutMs,
    },
  };
}

export interface WafBlockedRequest {
  timestamp: string;
  action: string;
  terminatingRuleId: string;
  clientIp: string;
  country: string;
  headers: Array<{ name: string; value: string }>;
  uri: string;
  args: string;
  httpVersion: string;
  httpMethod: string;
  requestId: string;
}

export interface WafBlockedRequestsResult {
  enabled: boolean;
  stage: string;
  range: WafRangeInput;
  checkedAt: string;
  webAclArn?: string;
  requests: WafBlockedRequest[];
  total: number;
  reason?: 'no-webacl' | 'no-logging-config' | 'no-data';
}

export async function getWafBlockedRequests(params: {
  stage: string;
  range: WafRangeInput;
}): Promise<WafBlockedRequestsResult> {
  const cacheKey = `waf-blocked-requests#${params.stage}#${rangeToCacheSegment(params.range)}`;
  return wafQueryCache.getOrFetch(cacheKey, WAF_CACHE_TTL.blockedRequests, () => fetchWafBlockedRequests(params));
}

async function fetchWafBlockedRequests(params: {
  stage: string;
  range: WafRangeInput;
}): Promise<WafBlockedRequestsResult> {
  const checkedAt = new Date().toISOString();

  const { webAclArn } = await resolveRouterWebAclArn();
  if (!webAclArn) {
    return {
      enabled: false,
      stage: params.stage,
      range: params.range,
      checkedAt,
      requests: [],
      total: 0,
      reason: 'no-webacl',
    };
  }

  const logGroupInfo = await resolveWafLogGroupInfo(webAclArn);
  if (!logGroupInfo) {
    return {
      enabled: false,
      stage: params.stage,
      range: params.range,
      checkedAt,
      webAclArn,
      requests: [],
      total: 0,
      reason: 'no-logging-config',
    };
  }

  const { startTime, endTime } = resolveTimeWindow(params.range);

  const { rows } = await runLogsInsightsQuery({
    region: logGroupInfo.region,
    logGroupName: logGroupInfo.name,
    startTime,
    endTime,
    queryString: `fields @timestamp, @message | filter action = "BLOCK" | sort @timestamp desc | limit 1000`,
    limit: 1000,
  });

  const requests: WafBlockedRequest[] = rows
    .map(row => {
      const rawMessage = row['@message'] ?? '';
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rawMessage) as Record<string, unknown>;
      } catch {
        return null;
      }

      const ts = row['@timestamp'] ?? '';
      const iso = parseIsoTimestamp(ts);
      if (!iso) return null;

      const httpRequest = (parsed.httpRequest ?? {}) as Record<string, unknown>;
      const rawHeaders = httpRequest.headers;
      const headers: Array<{ name: string; value: string }> = Array.isArray(rawHeaders)
        ? rawHeaders.filter(
            (h): h is { name: string; value: string } =>
              typeof h === 'object' &&
              h !== null &&
              typeof (h as Record<string, unknown>).name === 'string' &&
              typeof (h as Record<string, unknown>).value === 'string'
          )
        : [];

      return {
        timestamp: iso,
        action: typeof parsed.action === 'string' ? parsed.action : 'BLOCK',
        terminatingRuleId: typeof parsed.terminatingRuleId === 'string' ? parsed.terminatingRuleId : '',
        clientIp: typeof httpRequest.clientIp === 'string' ? httpRequest.clientIp : '',
        country: typeof httpRequest.country === 'string' ? httpRequest.country : '',
        headers,
        uri: typeof httpRequest.uri === 'string' ? httpRequest.uri : '',
        args: typeof httpRequest.args === 'string' ? httpRequest.args : '',
        httpVersion: typeof httpRequest.httpVersion === 'string' ? httpRequest.httpVersion : '',
        httpMethod: typeof httpRequest.httpMethod === 'string' ? httpRequest.httpMethod : '',
        requestId: typeof httpRequest.requestId === 'string' ? httpRequest.requestId : '',
      };
    })
    .filter((r): r is WafBlockedRequest => r !== null);

  return {
    enabled: true,
    stage: params.stage,
    range: params.range,
    checkedAt,
    webAclArn,
    requests,
    total: requests.length,
    ...(requests.length === 0 ? { reason: 'no-data' as const } : {}),
  };
}

export async function getWafLogsInsightsOverview(params: {
  stage: string;
  range: WafRangeInput;
  debug?: boolean;
}): Promise<WafLogsInsightsOverview> {
  // Bypass cache when debug mode is requested - always return fresh data for diagnostics.
  if (params.debug) return fetchWafLogsInsightsOverview(params);
  const cacheKey = `waf-logs-insights#${params.stage}#${rangeToCacheSegment(params.range)}`;
  return wafQueryCache.getOrFetch(cacheKey, WAF_CACHE_TTL.logsInsights, () => fetchWafLogsInsightsOverview(params));
}

async function fetchWafLogsInsightsOverview(params: {
  stage: string;
  range: WafRangeInput;
  debug?: boolean;
}): Promise<WafLogsInsightsOverview> {
  const checkedAt = new Date().toISOString();

  const { webAclArn } = await resolveRouterWebAclArn();
  if (!webAclArn) {
    return { enabled: false, stage: params.stage, range: params.range, checkedAt, reason: 'no-webacl' };
  }

  const logGroupInfo = await resolveWafLogGroupInfo(webAclArn);
  if (!logGroupInfo) {
    return {
      enabled: false,
      stage: params.stage,
      range: params.range,
      checkedAt,
      webAclArn,
      reason: 'no-logging-config',
    };
  }

  const { startTime, endTime } = resolveTimeWindow(params.range);

  const debugOut: Record<string, unknown> = {
    logGroupName: logGroupInfo.name,
    logGroupRegion: logGroupInfo.region,
    webAclArn,
  };

  // 1) Traffic characteristics
  const topBlockedUrisQuery = `
fields httpRequest.uri as uri
| filter action = "BLOCK" and ispresent(uri)
| stats count() as requests by uri
| sort requests desc
| limit 10
`.trim();

  // Groups by clientIp + country so labels show "COUNTRY - IP" for geographic context.
  const topClientIpsQuery = `
fields httpRequest.clientIp as clientIp, httpRequest.country as country
| filter ispresent(clientIp)
| stats count() as requests by clientIp, country
| sort requests desc
| limit 10
`.trim();

  const [blockedUrisRes, clientIpsRes] = await Promise.all([
    runLogsInsightsQuery({
      region: logGroupInfo.region,
      logGroupName: logGroupInfo.name,
      startTime,
      endTime,
      queryString: topBlockedUrisQuery,
    }),
    runLogsInsightsQuery({
      region: logGroupInfo.region,
      logGroupName: logGroupInfo.name,
      startTime,
      endTime,
      queryString: topClientIpsQuery,
    }),
  ]);

  const topBlockedUris = rowsToTopItems(blockedUrisRes.rows, 'uri', 'requests');
  const topClientIps = clientIpsRes.rows
    .map(r => {
      const clientIp = (r['clientIp'] ?? '').trim();
      const country = (r['country'] ?? '').trim();
      const count = Number((r['requests'] ?? '').trim());
      if (!clientIp || !Number.isFinite(count)) return null;
      const name = country ? `${country} • ${clientIp}` : clientIp;
      return { name, count };
    })
    .filter((v): v is WafLogsTopItem => Boolean(v))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // 2) Rate limit usage - bins the selected range into 5-minute windows (matching the
  //    api-rate-limit EvaluationWindowSec: 300) and finds the peak request count for each
  //    IP+URI pair in any single window. This shows which combinations came closest to
  //    triggering the rate limit at any point during the selected period.
  const rateLimitQuery = `
fields httpRequest.clientIp as ip, httpRequest.uri as uri
| filter ispresent(ip) and ispresent(uri)
| stats count() as requests by ip, uri, bin(5min)
| stats max(requests) as peakRequests by ip, uri
| sort peakRequests desc
| limit 10
`.trim();

  const rateLimitRes = await runLogsInsightsQuery({
    region: logGroupInfo.region,
    logGroupName: logGroupInfo.name,
    startTime,
    endTime,
    queryString: rateLimitQuery,
    limit: 10,
  });

  const topRateLimitIps: WafRateLimitIpUsage[] = rateLimitRes.rows
    .map(row => {
      const ip = (row['ip'] ?? '').trim();
      const uri = (row['uri'] ?? '').trim();
      const peakRequests = Number((row['peakRequests'] ?? '').trim());
      if (!ip || !uri || !Number.isFinite(peakRequests)) return null;
      return { ip, uri, peakRequests };
    })
    .filter((r): r is WafRateLimitIpUsage => r !== null);

  if (params.debug) {
    debugOut.topBlockedUrisQuery = topBlockedUrisQuery;
    debugOut.topClientIpsQuery = topClientIpsQuery;
    debugOut.rateLimitQuery = rateLimitQuery;
    debugOut.blockedUrisRes = blockedUrisRes.debug;
    debugOut.clientIpsRes = clientIpsRes.debug;
    debugOut.rateLimitRes = rateLimitRes.debug;
  }

  return {
    enabled: true,
    stage: params.stage,
    range: params.range,
    checkedAt,
    webAclArn,
    logGroupName: logGroupInfo.name,
    logGroupRegion: logGroupInfo.region,
    trafficCharacteristics: {
      topBlockedUris,
      topClientIps,
    },
    managedRuleGroups: {
      rateLimitUsage: {
        limitPerWindow: RATE_LIMIT,
        windowSecs: RATE_WINDOW_SECS,
        topIps: topRateLimitIps,
      },
    },
    ...(params.debug ? { debug: debugOut } : {}),
    ...(topBlockedUris.length === 0 && topClientIps.length === 0 ? { reason: 'no-data' as const } : {}),
  };
}

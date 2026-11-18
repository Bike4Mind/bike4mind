/**
 * Contributor Insights rules over the API server's `req-timing` lines
 * (apps/client/server/middlewares/baseApi.ts; method/path/clientIp come from
 * apps/client/server/middlewares/requestLogger.ts). Pure, so the alarm (infra/refusedRequestAlarms.ts),
 * the alarm relay's permissions (infra/dlqAlarms.ts) and the tests share one definition.
 */

/** The alarm's window. Must match REFUSED_REQUEST_WINDOW_SECONDS in apps/workers/src/events/refusedRequestBurstDetail.ts. */
export const REFUSED_REQUEST_WINDOW_SECONDS = 900;

/** One client IP's refused requests with no resolved user in one window; the alarm's default threshold. */
export const DEFAULT_REFUSED_REQUEST_THRESHOLD_PER_15MIN = 100;

/**
 * 401-405 sent to a caller with no resolved user (a signed-in caller's 405 or catch-all 404 can land
 * here too). `In` only compares strings and `status` is a JSON number, hence the range. 400 and 429 are left out: a 400 is a client sending a bad body,
 * and a 429 is a caller the rate limiter already throttles.
 */
const REFUSED_SIGNED_OUT_FILTERS = [
  { Match: '$.message', In: ['req-timing'] },
  { Match: '$.status', GreaterThan: 400 },
  { Match: '$.status', LessThan: 406 },
  // req-timing carries userId whenever the request resolved a user.
  { Match: '$.userId', IsPresent: false },
] as const;

export type RefusedRequestRuleKind = 'by-ip' | 'by-ip-path';

const RULE_KEYS: Record<RefusedRequestRuleKind, string[]> = {
  'by-ip': ['$.clientIp'],
  // Only read by the alarm relay, to name the top IP's paths.
  'by-ip-path': ['$.clientIp', '$.path'],
};

export function refusedRequestRuleName(appName: string, stage: string, kind: RefusedRequestRuleKind): string {
  return `${appName}-${stage}-refused-requests-${kind}`;
}

export function refusedRequestRuleDefinition(logGroupName: string, kind: RefusedRequestRuleKind): string {
  return JSON.stringify({
    Schema: { Name: 'CloudWatchLogRule', Version: 1 },
    LogGroupNames: [logGroupName],
    LogFormat: 'JSON',
    Contribution: { Keys: RULE_KEYS[kind], Filters: REFUSED_SIGNED_OUT_FILTERS },
    AggregateOn: 'Count',
  });
}

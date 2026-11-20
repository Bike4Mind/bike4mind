/**
 * Names the callers behind a refused-request burst alarm (infra/refusedRequestAlarms.ts): the top
 * client IPs from the Contributor Insights rule the alarm reads, the top IP's paths from its
 * per-(IP, path) sibling rule, and the ids of accounts that signed up from that IP. Every part
 * degrades to a one-line note, so the alarm itself always posts.
 */
import { CloudWatchClient, GetInsightRuleReportCommand } from '@aws-sdk/client-cloudwatch';
import { userRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

import { escapeMrkdwn, parseStateChangeTime } from './alarmSlackMessage';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';
import { connectRelayDb } from './relayDb';
import { adminUserUrl } from './youngAccountSpendDetail';

/** Set by infra/dlqAlarms.ts on the relay; names from infra/refusedRequestRules.ts. */
export const REFUSED_REQUEST_IP_RULE_ENV = 'REFUSED_REQUEST_IP_RULE';
export const REFUSED_REQUEST_IP_PATH_RULE_ENV = 'REFUSED_REQUEST_IP_PATH_RULE';

/** Must match REFUSED_REQUEST_WINDOW_SECONDS in infra/refusedRequestRules.ts. */
export const REFUSED_REQUEST_WINDOW_SECONDS = 900;
/**
 * Two alarm windows back from the state change: the alarm evaluates aligned periods a few minutes
 * late, so one window from the state change can cut the breaching period in half.
 */
const LOOKBACK_MS = 2 * REFUSED_REQUEST_WINDOW_SECONDS * 1000;
const REPORT_PERIOD_SECONDS = 60;
export const TOP_IP_LIMIT = 5;
export const TOP_PATH_LIMIT = 5;
/** (IP, path) pairs fetched; the top IP's are picked client-side, since a report cannot filter by key. */
const PATH_PAIRS_FETCHED = 100;
export const ACCOUNT_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 5_000;
const DB_TIMEOUT_MS = 2_000;
/** Slack caps a section's text at 3000 characters. */
const SECTION_TEXT_MAX = 2_900;
const VALUE_MAX = 120;

export const SECTION_TITLE = '*Top refused signed-out callers*';

export type InsightReportClient = Pick<CloudWatchClient, 'send'>;

export interface Contributor {
  keys: string[];
  count: number;
}

export interface ReportWindow {
  start: Date;
  end: Date;
}

export interface RefusedRequestBurstOptions {
  appUrl?: string;
  ipRule?: string;
  ipPathRule?: string;
  client?: InsightReportClient;
  findSignupAccountIds?: (ip: string, limit: number) => Promise<string[]>;
}

let defaultClient: CloudWatchClient | undefined;

export function reportWindow(alarm: CloudWatchAlarmPayload): ReportWindow | undefined {
  const end = parseStateChangeTime(alarm.StateChangeTime);
  return end ? { start: new Date(end.getTime() - LOOKBACK_MS), end } : undefined;
}

/** A rule's top contributors over the window, highest count first. */
export async function fetchTopContributors(
  client: InsightReportClient,
  ruleName: string,
  window: ReportWindow,
  maxContributors: number
): Promise<Contributor[]> {
  const report = await client.send(
    new GetInsightRuleReportCommand({
      RuleName: ruleName,
      StartTime: window.start,
      EndTime: window.end,
      Period: REPORT_PERIOD_SECONDS,
      MaxContributorCount: maxContributors,
      OrderBy: 'Sum',
    }),
    { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }
  );
  return (report.Contributors ?? [])
    .map(contributor => ({
      keys: contributor.Keys ?? [],
      count: Math.round(contributor.ApproximateAggregateValue ?? 0),
    }))
    .filter(contributor => contributor.keys.length > 0)
    .sort((a, b) => b.count - a.count);
}

async function findSignupAccountIdsInDb(ip: string, limit: number): Promise<string[]> {
  await connectRelayDb(DB_TIMEOUT_MS);
  return userRepository.findIdsBySignupIp(ip, undefined, limit);
}

/** A caller-supplied value as inline code: escaped, without backticks, and bounded. */
export function inlineCode(value: string): string {
  const clean = value.replace(/`/g, "'");
  const bounded = clean.length > VALUE_MAX ? `${clean.slice(0, VALUE_MAX)}...` : clean;
  return `\`${escapeMrkdwn(bounded)}\``;
}

const errorReason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function formatTopIps(ips: Contributor[]): string[] {
  if (ips.length === 0) return ['No contributor in the window yet; the rule report can lag the alarm by a minute.'];
  return ips.map(ip => `- ${inlineCode(ip.keys[0] ?? '')}: ${ip.count} refused`);
}

export function formatTopPaths(ip: string, pairs: Contributor[]): string[] {
  const paths = pairs.filter(pair => pair.keys[0] === ip && pair.keys[1]).slice(0, TOP_PATH_LIMIT);
  if (paths.length === 0) return [`Paths from ${inlineCode(ip)}: none in the fetched report.`];
  return [`Paths from ${inlineCode(ip)}:`, ...paths.map(pair => `- ${inlineCode(pair.keys[1] ?? '')}: ${pair.count}`)];
}

export function formatSignupAccounts(ip: string, ids: string[], appUrl: string | undefined): string {
  if (ids.length === 0) return `Accounts that signed up from ${inlineCode(ip)}: none.`;
  const shown = ids
    .slice(0, ACCOUNT_LIMIT)
    .map(id => (appUrl ? `<${adminUserUrl(appUrl, id)}|${id}>` : inlineCode(id)));
  const more = ids.length > ACCOUNT_LIMIT ? ' (and more)' : '';
  return `Accounts that signed up from ${inlineCode(ip)}: ${shown.join(', ')}${more}.`;
}

function section(lines: string[]): string {
  const text = [SECTION_TITLE, ...lines].join('\n');
  if (text.length <= SECTION_TEXT_MAX) return text;
  // Cut at a line boundary so an escaped entity is never left half written.
  const kept = text.slice(0, SECTION_TEXT_MAX);
  return `${kept.slice(0, Math.max(kept.lastIndexOf('\n'), 0))}\n...`;
}

/**
 * The section for an alarm, or a note saying why part of it is missing. Never throws: a failed
 * lookup must not stop the alarm from posting.
 */
export async function refusedRequestBurstSection(
  alarm: CloudWatchAlarmPayload,
  options: RefusedRequestBurstOptions = {}
): Promise<string> {
  const ipRule = options.ipRule ?? process.env[REFUSED_REQUEST_IP_RULE_ENV];
  const ipPathRule = options.ipPathRule ?? process.env[REFUSED_REQUEST_IP_PATH_RULE_ENV];
  if (!ipRule) return section(['Not available: the alarm relay has no refused-request rule configured.']);
  const window = reportWindow(alarm);
  if (!window) return section(['Not available: the alarm did not say when it changed state.']);
  const client = options.client ?? (defaultClient ??= new CloudWatchClient({ maxAttempts: 1 }));

  let ips: Contributor[];
  try {
    ips = await fetchTopContributors(client, ipRule, window, TOP_IP_LIMIT);
  } catch (error) {
    Logger.warn(`[refusedRequestBurstDetail] top IPs unavailable for ${alarm.AlarmName}: ${errorReason(error)}`);
    return section([
      `Could not be loaded (${errorReason(error)}). Open the ${inlineCode(ipRule)} rule in Contributor Insights.`,
    ]);
  }

  const lines = ['Last 30 minutes:', ...formatTopIps(ips)];
  const topIp = ips[0]?.keys[0];
  if (!topIp) return section(lines);

  const [pairs, accountIds] = await Promise.allSettled([
    ipPathRule ? fetchTopContributors(client, ipPathRule, window, PATH_PAIRS_FETCHED) : Promise.resolve(undefined),
    (options.findSignupAccountIds ?? findSignupAccountIdsInDb)(topIp, ACCOUNT_LIMIT + 1),
  ]);

  if (accountIds.status === 'rejected') {
    Logger.warn(`[refusedRequestBurstDetail] signup accounts unavailable: ${errorReason(accountIds.reason)}`);
    lines.push(
      `Accounts that signed up from ${inlineCode(topIp)}: could not be checked (${errorReason(accountIds.reason)}).`
    );
  } else {
    lines.push(formatSignupAccounts(topIp, accountIds.value, options.appUrl));
  }
  if (pairs.status === 'rejected') {
    Logger.warn(`[refusedRequestBurstDetail] top paths unavailable: ${errorReason(pairs.reason)}`);
    lines.push(`Paths from ${inlineCode(topIp)}: could not be loaded (${errorReason(pairs.reason)}).`);
  } else if (pairs.value) {
    lines.push(...formatTopPaths(topIp, pairs.value));
  }

  return section(lines);
}

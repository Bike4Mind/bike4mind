/**
 * Names the accounts behind a young-account spend alarm. The alarm's metric is a filter over the
 * `llm-usage-settled` lines in the ChatCompletion log group (infra/llmSpend.ts), so a Logs
 * Insights query over the same group and window splits the very number the alarm measured by
 * account and model. Slack gets account ids, spend, age, model mix and an admin link; never an
 * email or a name. Every failure degrades to a one-line note so the alarm itself still posts.
 */

import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  StopQueryCommand,
  type ResultField,
} from '@aws-sdk/client-cloudwatch-logs';

import { escapeMrkdwn, parseReason, parseStateChangeTime } from './alarmSlackMessage';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

/** Set by infra/dlqAlarms.ts on the relay; the ChatCompletion container log group. */
export const LLM_SPEND_LOG_GROUP_ENV = 'LLM_SPEND_LOG_GROUP';

export const TOP_ACCOUNT_LIMIT = 5;
const MODELS_PER_ACCOUNT = 3;
/** (account, model) pairs fetched; the top accounts are cut client-side after summing per account. */
const RESULT_ROW_LIMIT = 500;
/** Well inside the relay's 60-second timeout; a typical hour of lines answers in a few seconds. */
const QUERY_DEADLINE_MS = 25_000;
const POLL_INTERVAL_MS = 1_000;
/** StopQuery is best-effort cleanup; it must not eat the time left for the Slack post. */
const STOP_TIMEOUT_MS = 2_000;
/** Slack caps a section's text at 3000 characters. */
const SECTION_TEXT_MAX = 2_900;

export const SECTION_TITLE = '*Top accounts in the window*';

/**
 * Lines written before the account id joined the log line group under an empty id, so they are
 * filtered out. `sum(usd) as usd` returns nothing in Logs Insights (the alias shadows the field),
 * hence `spend`.
 */
export const YOUNG_ACCOUNT_SPEND_QUERY = [
  'fields usd, userId, model, accountCreatedAt',
  'filter message = "llm-usage-settled" and isYoungAccount = 1 and ispresent(userId)',
  'stats sum(usd) as spend, count(*) as calls, latest(accountCreatedAt) as createdAt by userId, model',
  'sort spend desc',
  `limit ${RESULT_ROW_LIMIT}`,
].join('\n| ');

export interface YoungAccountSpender {
  userId: string;
  usd: number;
  calls: number;
  accountCreatedAt?: Date;
  /** Highest spend first. */
  models: { model: string; usd: number }[];
}

export interface YoungAccountSpend {
  spenders: YoungAccountSpender[];
  /** The query hit RESULT_ROW_LIMIT, so smaller (account, model) pairs are missing from the sums. */
  truncated: boolean;
}

export interface SpendWindow {
  start: Date;
  end: Date;
}

export type LogsClient = Pick<CloudWatchLogsClient, 'send'>;

export interface FetchOptions {
  logGroup: string;
  client?: LogsClient;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

let defaultClient: CloudWatchLogsClient | undefined;

/**
 * The span the alarm evaluated: from the oldest breaching datapoint to the end of the newest
 * one, else the trigger's evaluation span ending at the state change.
 */
export function alarmWindow(alarm: CloudWatchAlarmPayload): SpendWindow | undefined {
  const parsed = parseReason(alarm);
  if (parsed.kind === 'threshold' && parsed.period) {
    return { start: new Date(parsed.earliestStart), end: new Date(parsed.latestStart + parsed.period * 1000) };
  }
  const end = parseStateChangeTime(alarm.StateChangeTime);
  const span = (alarm.Trigger?.Period ?? 0) * (alarm.Trigger?.EvaluationPeriods ?? 1);
  if (!end || span <= 0) return undefined;
  return { start: new Date(end.getTime() - span * 1000), end };
}

const rowToObject = (row: ResultField[]): Record<string, string> =>
  Object.fromEntries(
    row.filter(f => f.field && f.value !== undefined).map(f => [f.field as string, f.value as string])
  );

/** Sums the per-(account, model) rows into accounts, highest spend first. */
export function aggregateSpenders(rows: ResultField[][]): YoungAccountSpender[] {
  const byUser = new Map<string, YoungAccountSpender>();
  for (const raw of rows) {
    const row = rowToObject(raw);
    const userId = row.userId?.trim();
    if (!userId) continue;
    const usd = Number(row.spend);
    const calls = Number(row.calls);
    const spender = byUser.get(userId) ?? { userId, usd: 0, calls: 0, models: [] };
    spender.usd += Number.isFinite(usd) ? usd : 0;
    spender.calls += Number.isFinite(calls) ? calls : 0;
    if (row.model) spender.models.push({ model: row.model, usd: Number.isFinite(usd) ? usd : 0 });
    if (!spender.accountCreatedAt && row.createdAt) {
      const created = new Date(row.createdAt);
      if (!Number.isNaN(created.getTime())) spender.accountCreatedAt = created;
    }
    byUser.set(userId, spender);
  }
  const spenders = [...byUser.values()];
  for (const spender of spenders) spender.models.sort((a, b) => b.usd - a.usd);
  return spenders.sort((a, b) => b.usd - a.usd || a.userId.localeCompare(b.userId));
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Runs the query for the window and waits for it. Every call shares one deadline signal, so a
 * hung request cannot outlive it either; a query left running on any failure is stopped.
 */
export async function fetchYoungAccountSpenders(
  window: SpendWindow,
  options: FetchOptions
): Promise<YoungAccountSpend> {
  const client = options.client ?? (defaultClient ??= new CloudWatchLogsClient({}));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? QUERY_DEADLINE_MS;
  const deadline = now() + deadlineMs;
  const abortSignal = AbortSignal.timeout(deadlineMs);
  const timedOut = () => new Error('Logs Insights query did not finish in time');

  let queryId: string | undefined;
  let settled = false;
  try {
    const started = await client.send(
      new StartQueryCommand({
        logGroupName: options.logGroup,
        startTime: Math.floor(window.start.getTime() / 1000),
        endTime: Math.ceil(window.end.getTime() / 1000),
        queryString: YOUNG_ACCOUNT_SPEND_QUERY,
        limit: RESULT_ROW_LIMIT,
      }),
      { abortSignal }
    );
    queryId = started.queryId;
    if (!queryId) throw new Error('Logs Insights returned no query id');

    for (;;) {
      const result = await client.send(new GetQueryResultsCommand({ queryId }), { abortSignal });
      const status = result.status ?? 'Unknown';
      if (status === 'Complete') {
        settled = true;
        const rows = result.results ?? [];
        return { spenders: aggregateSpenders(rows), truncated: rows.length >= RESULT_ROW_LIMIT };
      }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        settled = true;
        throw new Error(`Logs Insights query ${status.toLowerCase()}`);
      }
      if (now() >= deadline) throw timedOut();
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    throw abortSignal.aborted ? timedOut() : error;
  } finally {
    if (queryId && !settled) {
      await client
        .send(new StopQueryCommand({ queryId }), { abortSignal: AbortSignal.timeout(STOP_TIMEOUT_MS) })
        .catch(() => undefined);
    }
  }
}

const formatUsd = (usd: number) => (usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toFixed(4));

/** "12 min old", "3 h old", "2 d old" at the end of the window; the alarm's own clock, not now. */
export function formatAccountAge(createdAt: Date | undefined, at: Date): string {
  if (!createdAt) return 'age unknown';
  const minutes = Math.max(0, Math.round((at.getTime() - createdAt.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h old`;
  return `${Math.round(hours / 24)} d old`;
}

/** Same path as the young-account spend post in LiveOps (apps/workers/src/cron/youngAccountSpendAlert.ts). */
const adminUserUrl = (appUrl: string, userId: string) =>
  `${appUrl.replace(/\/+$/, '')}/admin/users/${encodeURIComponent(userId)}`;

function describeModels(models: YoungAccountSpender['models']): string {
  if (models.length === 0) return 'no model recorded';
  const shown = models.slice(0, MODELS_PER_ACCOUNT).map(m => `${escapeMrkdwn(m.model)} ${formatUsd(m.usd)}`);
  const more = models.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

export function formatSpenderLine(
  spender: YoungAccountSpender,
  rank: number,
  windowEnd: Date,
  appUrl: string | undefined
): string {
  const link = appUrl ? `  <${adminUserUrl(appUrl, spender.userId)}|admin>` : '';
  return (
    `${rank}. \`${escapeMrkdwn(spender.userId)}\` ${formatUsd(spender.usd)} USD in ${spender.calls} ` +
    `${spender.calls === 1 ? 'call' : 'calls'}, ${formatAccountAge(spender.accountCreatedAt, windowEnd)}: ` +
    `${describeModels(spender.models)}${link}`
  );
}

/** One mrkdwn section listing the top accounts; capped by count and by Slack's section size. */
export function formatYoungAccountSpenders(
  spenders: YoungAccountSpender[],
  options: { windowEnd: Date; appUrl?: string; limit?: number; truncated?: boolean }
): string {
  if (spenders.length === 0) {
    return `${SECTION_TITLE}\nNo account is named on the spend lines for this window.`;
  }
  const limit = options.limit ?? TOP_ACCOUNT_LIMIT;
  const lines = spenders.slice(0, limit).map((s, i) => formatSpenderLine(s, i + 1, options.windowEnd, options.appUrl));
  const assemble = () => {
    const rest = spenders.length - lines.length;
    const noun = rest === 1 ? 'account' : 'accounts';
    // Past the row limit the tail is unseen, so the count is a floor and the sums may run short.
    const footer = options.truncated
      ? `and ${rest > 0 ? `at least ${rest} more ${noun}` : 'possibly more accounts'} (query capped at ${RESULT_ROW_LIMIT} rows)`
      : rest > 0
        ? `and ${rest} more ${noun}`
        : undefined;
    return [SECTION_TITLE, ...lines, footer].filter(Boolean).join('\n');
  };
  let text = assemble();
  while (text.length > SECTION_TEXT_MAX && lines.length > 1) {
    lines.pop();
    text = assemble();
  }
  return text;
}

const fallback = (reason: string) => `${SECTION_TITLE}\n${escapeMrkdwn(reason)}`;

/**
 * The section for an alarm, or a note saying why the accounts could not be listed. Never throws:
 * a failed lookup must not stop the alarm from posting.
 */
export async function youngAccountSpendSection(
  alarm: CloudWatchAlarmPayload,
  options: { appUrl?: string; logGroup?: string; fetch?: typeof fetchYoungAccountSpenders } = {}
): Promise<string> {
  const logGroup = (options.logGroup ?? process.env[LLM_SPEND_LOG_GROUP_ENV])?.trim();
  if (!logGroup) return fallback('Not available: the alarm relay has no spend log group configured.');
  const window = alarmWindow(alarm);
  if (!window) return fallback('Not available: the alarm did not say which window breached.');
  try {
    const { spenders, truncated } = await (options.fetch ?? fetchYoungAccountSpenders)(window, { logGroup });
    return formatYoungAccountSpenders(spenders, { windowEnd: window.end, appUrl: options.appUrl, truncated });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[youngAccountSpendDetail] could not list accounts for ${alarm.AlarmName}: ${reason}`);
    return fallback(`Could not be loaded (${reason}). Query the ChatCompletion log group for the window instead.`);
  }
}

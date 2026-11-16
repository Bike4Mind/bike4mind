/**
 * Breaks down a per-provider ledger spend alarm (llm-spend-hourly, its warn tier, llm-spend-rate) so
 * whoever is paged can tell heavy use from a credit farm without opening a dashboard: the young-account
 * share, the spend by source and model, and the top accounts. One Logs Insights query over the same
 * `llm-usage-settled` lines and window the alarm measured (see youngAccountSpendDetail.ts for the
 * shared window and log-group plumbing). Slack gets account ids, spend and age; never an email or a
 * name. Every failure degrades to a one-line note so the alarm itself still posts.
 */
import { Logger } from '@bike4mind/observability';

import type { ResultField } from '@aws-sdk/client-cloudwatch-logs';

import { rowToObject, runLogsInsightsQuery, type LogsClient } from '../utils/logsInsights';

import { alarmProvider, escapeMrkdwn, type AlarmProvider } from './alarmSlackMessage';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';
import {
  adminUserUrl,
  alarmWindow,
  formatAccountAge,
  formatUsd,
  LLM_SPEND_LOG_GROUPS_ENV,
  measuredWindowUsd,
  type SpendWindow,
} from './youngAccountSpendDetail';

export const SECTION_TITLE = '*Where the spend went*';
const TOP_ACCOUNTS = 3;
const TOP_MODELS = 3;
/** (account, model, source, age bucket) groups fetched; enough for an hour of normal traffic. */
const RESULT_ROW_LIMIT = 1_000;
/** One read, no catch-up re-read: the breakdown is a triage aid, not the measurement. */
const QUERY_DEADLINE_MS = 20_000;
const COVERAGE_TOLERANCE_USD = 0.005;
/** Slack caps a section's text at 3000 characters. */
const SECTION_TEXT_MAX = 2_900;
const UNATTRIBUTED = '(no account)';

/** `sum(usd) as usd` returns nothing in Logs Insights (the alias shadows the field), hence `spend`. */
export function providerSpendQuery(provider: AlarmProvider): string {
  return [
    'fields usd, userId, model, source, isYoungAccount, accountCreatedAt',
    `filter message = "llm-usage-settled" and provider = "${provider}"`,
    'stats sum(usd) as spend, count(*) as calls, latest(accountCreatedAt) as createdAt by userId, model, source, isYoungAccount',
    'sort spend desc',
    `limit ${RESULT_ROW_LIMIT}`,
  ].join('\n| ');
}

export interface SpendGroup {
  usd: number;
  calls: number;
}

export interface AccountSpend extends SpendGroup {
  userId: string;
  accountCreatedAt?: Date;
  young: boolean;
}

export interface ProviderSpendBreakdown {
  total: SpendGroup;
  young: SpendGroup;
  /** Highest spend first. */
  models: ({ model: string } & SpendGroup)[];
  sources: ({ source: string } & SpendGroup)[];
  accounts: AccountSpend[];
  /** The query hit RESULT_ROW_LIMIT, so the smallest groups are missing from the sums. */
  truncated: boolean;
}

const toNumber = (raw: string | undefined) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const isTrue = (raw: string | undefined) => raw === '1' || raw?.toLowerCase() === 'true';

function addTo<K>(map: Map<K, SpendGroup>, key: K, usd: number, calls: number): void {
  const group = map.get(key) ?? { usd: 0, calls: 0 };
  group.usd += usd;
  group.calls += calls;
  map.set(key, group);
}

const byUsd = <T extends SpendGroup>(a: T, b: T) => b.usd - a.usd;

/** Sums the grouped rows into the totals, the young share and the per-model, source and account lists. */
export function aggregateProviderSpend(rows: ResultField[][]): ProviderSpendBreakdown {
  const total: SpendGroup = { usd: 0, calls: 0 };
  const young: SpendGroup = { usd: 0, calls: 0 };
  const models = new Map<string, SpendGroup>();
  const sources = new Map<string, SpendGroup>();
  const accounts = new Map<string, AccountSpend>();

  for (const raw of rows) {
    const row = rowToObject(raw);
    const usd = toNumber(row.spend);
    const calls = toNumber(row.calls);
    const isYoung = isTrue(row.isYoungAccount);
    total.usd += usd;
    total.calls += calls;
    if (isYoung) {
      young.usd += usd;
      young.calls += calls;
    }
    addTo(models, row.model?.trim() || 'unknown model', usd, calls);
    addTo(sources, row.source?.trim() || 'unknown', usd, calls);

    const userId = row.userId?.trim() || UNATTRIBUTED;
    const account = accounts.get(userId) ?? { userId, usd: 0, calls: 0, young: false };
    account.usd += usd;
    account.calls += calls;
    account.young ||= isYoung;
    if (!account.accountCreatedAt && row.createdAt) {
      const created = new Date(row.createdAt);
      if (!Number.isNaN(created.getTime())) account.accountCreatedAt = created;
    }
    accounts.set(userId, account);
  }

  return {
    total,
    young,
    models: [...models].map(([model, group]) => ({ model, ...group })).sort(byUsd),
    sources: [...sources].map(([source, group]) => ({ source, ...group })).sort(byUsd),
    accounts: [...accounts.values()].sort((a, b) => byUsd(a, b) || a.userId.localeCompare(b.userId)),
    truncated: rows.length >= RESULT_ROW_LIMIT,
  };
}

export interface FetchOptions {
  logGroups: string[];
  client?: LogsClient;
  deadlineMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function fetchProviderSpend(
  provider: AlarmProvider,
  window: SpendWindow,
  options: FetchOptions
): Promise<ProviderSpendBreakdown> {
  const { logGroups, ...queryOptions } = options;
  const rows = await runLogsInsightsQuery(
    { logGroups, window, queryString: providerSpendQuery(provider), limit: RESULT_ROW_LIMIT },
    { deadlineMs: QUERY_DEADLINE_MS, ...queryOptions }
  );
  return aggregateProviderSpend(rows);
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((100 * part) / whole) : 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function shareList(groups: ({ name: string } & SpendGroup)[], whole: number, limit: number): string {
  const shown = groups
    .slice(0, limit)
    .map(g => `${escapeMrkdwn(g.name)} ${formatUsd(g.usd)} (${percent(g.usd, whole)}%)`);
  const more = groups.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}

function accountLine(account: AccountSpend, rank: number, windowEnd: Date, appUrl: string | undefined): string {
  if (account.userId === UNATTRIBUTED) {
    return `${rank}. no account on the line: ${formatUsd(account.usd)} USD in ${plural(account.calls, 'call')}`;
  }
  const link = appUrl ? `  <${adminUserUrl(appUrl, account.userId)}|admin>` : '';
  const age = formatAccountAge(account.accountCreatedAt, windowEnd);
  return (
    `${rank}. \`${escapeMrkdwn(account.userId)}\` ${formatUsd(account.usd)} USD in ${plural(account.calls, 'call')}, ` +
    `${age}${account.young ? ' (new account)' : ''}${link}`
  );
}

/** One mrkdwn section with the share lines first, then the top accounts; capped to Slack's section size. */
export function formatProviderSpend(
  breakdown: ProviderSpendBreakdown,
  options: { windowEnd: Date; appUrl?: string; measuredUsd?: number }
): string {
  const { total, young } = breakdown;
  if (total.calls === 0) {
    return `${SECTION_TITLE}\nNo spend lines were found for this provider and window yet; check the LLM spend dashboard.`;
  }
  const lines = [
    SECTION_TITLE,
    `Accounts under 7 days old: *${formatUsd(young.usd)} of ${formatUsd(total.usd)} USD (${percent(young.usd, total.usd)}%)*`,
    `By source: ${shareList(
      breakdown.sources.map(s => ({ name: s.source, ...s })),
      total.usd,
      breakdown.sources.length
    )}`,
    `Top models: ${shareList(
      breakdown.models.map(m => ({ name: m.model, ...m })),
      total.usd,
      TOP_MODELS
    )}`,
    'Top accounts:',
    ...breakdown.accounts
      .slice(0, TOP_ACCOUNTS)
      .map((account, i) => accountLine(account, i + 1, options.windowEnd, options.appUrl)),
  ];
  if (breakdown.truncated) {
    lines.push(`Query capped at ${RESULT_ROW_LIMIT} groups, so the smallest spenders are left out of the sums.`);
  } else if (options.measuredUsd !== undefined && total.usd < options.measuredUsd - COVERAGE_TOLERANCE_USD) {
    lines.push(
      `These lines add up to ${formatUsd(total.usd)} of the ${formatUsd(options.measuredUsd)} USD measured; the newest calls may not be searchable yet.`
    );
  }
  let text = lines.join('\n');
  while (text.length > SECTION_TEXT_MAX && lines.length > 2) {
    lines.splice(lines.length - 1, 1);
    text = lines.join('\n');
  }
  return text;
}

const fallback = (reason: string) => `${SECTION_TITLE}\n${escapeMrkdwn(reason)}`;

/**
 * The breakdown section for an alarm, or a note saying why it could not be built. Never throws: a
 * failed lookup must not stop the alarm from posting.
 */
export async function providerSpendSection(
  alarm: CloudWatchAlarmPayload,
  options: { appUrl?: string; logGroups?: string[]; fetch?: typeof fetchProviderSpend } = {}
): Promise<string> {
  const logGroups = (options.logGroups ?? (process.env[LLM_SPEND_LOG_GROUPS_ENV] ?? '').split(','))
    .map(name => name.trim())
    .filter(Boolean);
  if (logGroups.length === 0) return fallback('Not available: the alarm relay has no spend log group configured.');
  const provider = alarmProvider(alarm);
  if (!provider) return fallback('Not available: the alarm does not name a provider.');
  const window = alarmWindow(alarm);
  if (!window) return fallback('Not available: the alarm did not say which window breached.');
  try {
    const breakdown = await (options.fetch ?? fetchProviderSpend)(provider, window, { logGroups });
    return formatProviderSpend(breakdown, {
      windowEnd: window.end,
      appUrl: options.appUrl,
      measuredUsd: measuredWindowUsd(alarm),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    Logger.warn(`[providerSpendDetail] could not break down ${alarm.AlarmName}: ${reason}`);
    return fallback(`Could not be loaded (${reason}). Open the LLM spend dashboard's by-model widget instead.`);
  }
}

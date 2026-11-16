import { AccountContextSchema } from '@bike4mind/server-utils/lib/accounts/accountContext';
import { escapeSlackLine, type ISpendAlert, type SpendRuleId } from '@bike4mind/common';
import {
  ADMIN_LINKS,
  composeAlarmMessage,
  escapeMrkdwn,
  type AlarmLevel,
  type SlackAlarmMessage,
} from '../../events/alarmSlackMessage';
import { SPEND_WINDOW_MS } from './baselines';
import type { ResolvedScope } from './resolveScope';
import type { AccountFunding, TopAccountContext } from './topAccountContext';

export type SpendAlertMessageInput = {
  kind: 'open' | 'escalate' | 'resolve';
  alert: ISpendAlert;
  scope: ResolvedScope;
  breakdown?: {
    topModels: { model: string; credits: number }[];
    /** `account` is absent when its lookup failed or found no record; the line then shows label and credits only. */
    topAccounts?: { label: string; credits: number; account?: TopAccountContext }[];
    sources?: Record<string, number>;
  };
  /** USD per credit, used only to show an approximate dollar figure. */
  creditUsd: number;
  stage: string;
  appUrl?: string;
  mention?: string;
};

const RULE_TITLES: Record<SpendRuleId, string> = {
  platform_spike: 'Platform spend spike',
  platform_cost_spike: 'Platform provider-cost spike',
  account_spike: 'Account spend spike',
  account_ceiling: 'Account spend ceiling',
  apikey_spike: 'API key spend spike',
  apikey_ceiling: 'API key spend ceiling',
};

const PLATFORM_RULES: ReadonlySet<SpendRuleId> = new Set(['platform_spike', 'platform_cost_spike']);

const safe = escapeMrkdwn;

/** A key name is user text on a single labeled line: no line breaks, bounded length. */
const KEY_NAME_MAX = 60;
const keyName = (name: string) =>
  escapeSlackLine(name.length > KEY_NAME_MAX ? `${name.slice(0, KEY_NAME_MAX)}...` : name);

const SLACK_FIELD_MAX = 2000;

function foldedKeysField(names: string[]): string {
  const heading = '*Via API keys*\n';
  const listed: string[] = [];
  for (const name of names) {
    const formattedName = keyName(name);
    const candidate = [...listed, formattedName];
    const remaining = names.length - candidate.length;
    const suffix = remaining > 0 ? `, +${remaining} more` : '';
    if (heading.length + candidate.join(', ').length + suffix.length > SLACK_FIELD_MAX) break;
    listed.push(formattedName);
  }
  const remaining = names.length - listed.length;
  return `${heading}${listed.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''}`;
}

const formatCredits = (credits: number) => Math.round(credits).toLocaleString('en-US');
const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;
const listPriceNote = (creditUsd: number) => `approx. at list price, ${formatUsd(creditUsd * 1000)} per 1,000 credits`;

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

const WINDOW_LABEL = formatDuration(SPEND_WINDOW_MS);

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function formatAmount(rule: SpendRuleId, amount: number, creditUsd: number): string {
  if (rule === 'platform_cost_spike') return formatUsd(amount);
  return `${formatCredits(amount)} credits (~${formatUsd(amount * creditUsd)})`;
}

function listPriceContext(stage: string, rule: SpendRuleId, creditUsd: number): string[] {
  const context = [safe(stage)];
  if (rule !== 'platform_cost_spike') context.push(listPriceNote(creditUsd));
  return context;
}

function accountTierLabel(alert: ISpendAlert): string | null {
  const tier = alert.context.accountTier;
  if (tier === 'standard' || tier === 'paid' || tier === 'trusted') return tier;
  return alert.context.trusted === true ? 'trusted' : null;
}

function accountLimitContext(alert: ISpendAlert): string[] {
  const tier = accountTierLabel(alert);
  const spikeFloor = numberOrNull(alert.context.spikeFloorCredits);
  const ceiling = numberOrNull(alert.context.ceilingCredits);
  return [
    ...(tier ? [`${tier}-account limits`] : []),
    ...(spikeFloor !== null ? [`spike floor: ${formatCredits(spikeFloor)} credits / ${WINDOW_LABEL}`] : []),
    ...(ceiling !== null ? [`critical ceiling: ${formatCredits(ceiling)} credits / ${WINDOW_LABEL}`] : []),
  ];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const YEAR_MS = 365 * DAY_MS;

/** Coarse account age: minutes under an hour, hours under two days, days under a year, then whole years. */
export function formatAccountAge(ms: number | null): string {
  if (ms === null) return 'age unknown';
  if (ms < HOUR_MS) return `${Math.max(1, Math.floor(ms / MINUTE_MS))} min old`;
  if (ms < 2 * DAY_MS) return `${Math.floor(ms / HOUR_MS)} h old`;
  if (ms < YEAR_MS) return `${Math.floor(ms / DAY_MS)} d old`;
  return `${Math.floor(ms / YEAR_MS)} y old`;
}

const FUNDING_LABELS: Record<AccountFunding, string> = {
  subscription: 'paid (subscription)',
  purchase: 'paid (credit purchase)',
  stripe_customer: 'Stripe customer, no purchase',
  granted: 'free (granted credits only)',
};

type TopAccount = NonNullable<NonNullable<SpendAlertMessageInput['breakdown']>['topAccounts']>[number];

function topAccountLine({ label, credits, account }: TopAccount, appUrl: string | undefined): string {
  const line = `${safe(label)}: ${formatCredits(credits)}`;
  if (!account) return line;
  const balance =
    account.creditBalance === null ? 'balance unknown' : `balance ${formatCredits(account.creditBalance)}`;
  const facts = [account.kind, formatAccountAge(account.ageMs), balance, FUNDING_LABELS[account.funding]];
  const activity = account.topModel ? `; ${safe(account.topModel.model)} x${account.topModel.calls}` : '';
  const link = appUrl ? ` <${appUrl}${account.adminPath}|admin>` : '';
  return `${line} - ${facts.join(', ')}${activity}${link}`;
}

const formatAge = (days: number | null): string => (days === null ? 'unknown' : `${days.toFixed(1)} days`);
const formatFlag = (value: boolean | null): string => (value === null ? 'unknown' : value ? 'yes' : 'no');

function accountContextSections(alert: ISpendAlert): string[] {
  if (alert.context.accountContext === undefined && alert.context.policyReasons === undefined) return [];
  const parsed = AccountContextSchema.safeParse(alert.context.accountContext);
  const reasons = Array.isArray(alert.context.policyReasons)
    ? alert.context.policyReasons
        .filter((reason): reason is string => typeof reason === 'string')
        .slice(0, 6)
        .map(reason => escapeSlackLine(reason.slice(0, 100)))
    : [];
  const explanation = reasons.length > 0 ? [`Policy: ${reasons.join(', ')}`] : [];
  if (!parsed.success)
    return [
      `*Account context*\nunknown (unavailable or invalid)${explanation.length > 0 ? `\n${explanation[0]}` : ''}`,
    ];
  const context = parsed.data;
  const paymentHistory =
    context.payments.status === 'observed'
      ? `${context.payments.succeeded} succeeded, ${context.payments.failed} failed, ${context.payments.radarBlocked} blocked, ${context.payments.elevatedRisk} elevated-risk; latest succeeded attempt started ${formatAge(context.payments.latestSucceededAgeDays)} ago`
      : 'unknown (no retained payment history)';
  const evidence =
    context.evidence.status === 'observed'
      ? `observed, ${context.evidence.ageHours === null ? 'age unknown' : `${context.evidence.ageHours.toFixed(1)} hours old`}`
      : 'unknown (no behavioral evidence)';
  return [
    [
      '*Account context*',
      `Account age: ${formatAge(context.accountAgeDays)}; responsible owner: ${formatAge(context.responsibleAccountAgeDays)}`,
      `Email verified: ${formatFlag(context.emailVerified)}; review: ${context.reviewState}; risk score: ${context.riskScore ?? 'unknown'}`,
      `Review reopened: ${formatFlag(context.reviewReopened)}; payment-risk event: ${formatFlag(context.paymentRiskEvent)}`,
      `Unreversed credit purchase: ${formatFlag(context.hasCreditPurchase)}; latest purchase: ${formatAge(context.lastCreditPurchaseAgeDays)}`,
      `Retained payment history: ${paymentHistory}`,
      `Behavioral evidence: ${evidence}`,
      ...explanation,
    ].join('\n'),
  ];
}

function buildResolveMessage(input: SpendAlertMessageInput, title: string): SlackAlarmMessage {
  const { alert, scope, creditUsd } = input;
  const peak =
    alert.rule === 'platform_cost_spike' ? formatUsd(alert.peakValue) : `${formatCredits(alert.peakValue)} credits`;
  const endedAt = alert.resolvedAt ?? new Date();
  const duration = formatDuration(endedAt.getTime() - alert.openedAt.getTime());
  const accountTier = accountTierLabel(alert);
  const tier = accountTier ? ` (${accountTier})` : '';
  const line = `Resolved: ${title} - ${scope.label}${tier}, peak ${peak}, lasted ${duration}`;

  return composeAlarmMessage({
    stage: input.stage,
    level: 'info',
    title: line,
    sections: accountContextSections(alert),
    context: [...listPriceContext(input.stage, alert.rule, creditUsd), ...accountLimitContext(alert)],
    summary: 'spend incident resolved',
  });
}

export function buildSpendAlertMessage(input: SpendAlertMessageInput): SlackAlarmMessage {
  const { kind, alert, scope, breakdown, creditUsd, stage } = input;
  const title = RULE_TITLES[alert.rule];
  if (kind === 'resolve') return buildResolveMessage(input, title);

  const critical = alert.severity === 'critical';
  const level: AlarmLevel = critical ? 'page' : 'warn';
  const baseline = numberOrNull(alert.context.baseline);
  const ratio = numberOrNull(alert.context.ratio);
  const isCost = alert.rule === 'platform_cost_spike';
  const tier = accountTierLabel(alert);
  const excluded = numberOrNull(alert.context.trustedExcluded);
  const trustedExcluded = excluded !== null && excluded > 0 ? excluded : null;

  const fields = [
    `*Scope*\n${safe(scope.label)}${tier ? ` (${tier})` : ''}`,
    `*Last ${WINDOW_LABEL}*\n${formatAmount(alert.rule, alert.lastValue, creditUsd)}`,
    `*${trustedExcluded === null ? 'Normal' : 'Normal excl. trusted'} (${WINDOW_LABEL})*\n${baseline === null ? 'no history' : formatAmount(alert.rule, baseline, creditUsd)}`,
    `*Ratio*\n${ratio === null ? 'n/a' : `x${ratio.toFixed(1)}`}`,
  ];
  if (scope.paidBy) fields.push(`*Paid by*\n${safe(scope.paidBy)}`);
  const viaKeys = Array.isArray(alert.context.viaKeys)
    ? alert.context.viaKeys.filter((name): name is string => typeof name === 'string')
    : [];
  if (viaKeys.length > 0) fields.push(foldedKeysField(viaKeys));
  // Platform ratios and floors are judged without trusted accounts; the reported total still includes them.
  if (trustedExcluded !== null) {
    const estimate = isCost ? ' (est.)' : '';
    fields.push(`*Trusted accounts, not in ratio*\n${formatAmount(alert.rule, trustedExcluded, creditUsd)}${estimate}`);
  }

  const appUrl = input.appUrl?.replace(/\/+$/, '');
  const sections: string[] = accountContextSections(alert);
  if (breakdown?.topModels.length) {
    const lines = breakdown.topModels.map(m => `${safe(m.model)}: ${formatCredits(m.credits)}`);
    sections.push(`*Top models (credits)*\n${lines.join('\n')}`);
  }
  if (PLATFORM_RULES.has(alert.rule) && breakdown?.topAccounts?.length) {
    const lines = breakdown.topAccounts.map(account => topAccountLine(account, appUrl));
    sections.push(`*Top accounts (credits)*\n${lines.join('\n')}`);
  }
  if (breakdown?.sources && Object.keys(breakdown.sources).length > 0) {
    const lines = Object.entries(breakdown.sources)
      .sort((left, right) => right[1] - left[1])
      .map(([source, credits]) => `${safe(source)}: ${formatCredits(credits)}`);
    sections.push(`*Where it was spent (credits)*\n${lines.join('\n')}`);
  }

  const buttons: { label: string; url: string }[] = [];
  if (appUrl) {
    if (scope.adminPath) buttons.push({ label: `Open ${scope.label}`, url: `${appUrl}${scope.adminPath}` });
    buttons.push({ label: ADMIN_LINKS['spend-monitor'].label, url: `${appUrl}${ADMIN_LINKS['spend-monitor'].path}` });
  }

  const context = [safe(stage), `${kind === 'escalate' ? 'escalated, ' : ''}${alert.severity}`];
  context.push(...accountLimitContext(alert));
  if (!isCost) context.push(listPriceNote(creditUsd));

  return composeAlarmMessage({
    stage,
    level,
    title: `Spend ${alert.severity}: ${title}`,
    mention: critical ? input.mention : undefined,
    fields,
    sections,
    buttons,
    context,
    summary: `${scope.label}, ${formatAmount(alert.rule, alert.lastValue, creditUsd)} in the last ${WINDOW_LABEL}`,
  });
}

import type { ISpendAlert, SpendRuleId } from '@bike4mind/common';
import {
  ADMIN_LINKS,
  composeAlarmMessage,
  escapeMrkdwn,
  type AlarmLevel,
  type SlackAlarmMessage,
} from '../../events/alarmSlackMessage';
import type { ResolvedScope } from './resolveScope';

export type SpendAlertMessageInput = {
  kind: 'open' | 'escalate' | 'resolve';
  alert: ISpendAlert;
  scope: ResolvedScope;
  breakdown?: {
    topModels: { model: string; credits: number }[];
    topAccounts?: { label: string; credits: number }[];
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

const formatCredits = (credits: number) => Math.round(credits).toLocaleString('en-US');
const formatUsd = (usd: number) => `$${usd.toFixed(2)}`;

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function formatAmount(rule: SpendRuleId, amount: number, creditUsd: number): string {
  if (rule === 'platform_cost_spike') return formatUsd(amount);
  return `${formatCredits(amount)} credits (~${formatUsd(amount * creditUsd)})`;
}

function listPriceContext(stage: string, rule: SpendRuleId, creditUsd: number): string[] {
  const context = [safe(stage)];
  if (rule !== 'platform_cost_spike') context.push(`approx. at list price, ${formatUsd(creditUsd)} per credit`);
  return context;
}

function buildResolveMessage(input: SpendAlertMessageInput, title: string): SlackAlarmMessage {
  const { alert, scope, creditUsd } = input;
  const peak =
    alert.rule === 'platform_cost_spike' ? formatUsd(alert.peakValue) : `${formatCredits(alert.peakValue)} credits`;
  const endedAt = alert.resolvedAt ?? new Date();
  const duration = formatDuration(endedAt.getTime() - alert.openedAt.getTime());
  const line = `Resolved: ${title} - ${scope.label}, peak ${peak}, lasted ${duration}`;

  return composeAlarmMessage({
    stage: input.stage,
    level: 'info',
    title: line,
    sections: [],
    context: listPriceContext(input.stage, alert.rule, creditUsd),
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

  const fields = [
    `*Scope*\n${safe(scope.label)}`,
    `*Last 15m*\n${formatAmount(alert.rule, alert.lastValue, creditUsd)}`,
    `*Normal (15m)*\n${baseline === null ? 'no history' : formatAmount(alert.rule, baseline, creditUsd)}`,
    `*Ratio*\n${ratio === null ? 'n/a' : `x${ratio.toFixed(1)}`}`,
  ];

  const sections: string[] = [];
  if (breakdown?.topModels.length) {
    const lines = breakdown.topModels.map(m => `${safe(m.model)}: ${formatCredits(m.credits)}`);
    sections.push(`*Top models (credits)*\n${lines.join('\n')}`);
  }
  if (PLATFORM_RULES.has(alert.rule) && breakdown?.topAccounts?.length) {
    const lines = breakdown.topAccounts.map(a => `${safe(a.label)}: ${formatCredits(a.credits)}`);
    sections.push(`*Top accounts (credits)*\n${lines.join('\n')}`);
  }
  if (!PLATFORM_RULES.has(alert.rule) && breakdown?.sources && Object.keys(breakdown.sources).length > 0) {
    const lines = Object.entries(breakdown.sources).map(
      ([source, credits]) => `${safe(source)}: ${formatCredits(credits)}`
    );
    sections.push(`*Source mix (credits)*\n${lines.join('\n')}`);
  }

  const buttons: { label: string; url: string }[] = [];
  const appUrl = input.appUrl?.replace(/\/+$/, '');
  if (appUrl) {
    if (scope.adminPath) buttons.push({ label: `Open ${scope.label}`, url: `${appUrl}${scope.adminPath}` });
    buttons.push({ label: ADMIN_LINKS['spend-monitor'].label, url: `${appUrl}${ADMIN_LINKS['spend-monitor'].path}` });
  }

  const context = [safe(stage), `${kind === 'escalate' ? 'escalated, ' : ''}${alert.severity}`];
  if (!isCost) context.push(`approx. at list price, ${formatUsd(creditUsd)} per credit`);

  return composeAlarmMessage({
    stage,
    level,
    title: `Spend ${alert.severity}: ${title}`,
    mention: critical ? input.mention : undefined,
    fields,
    sections,
    buttons,
    context,
    summary: `${scope.label}, ${formatAmount(alert.rule, alert.lastValue, creditUsd)} in the last 15m`,
  });
}

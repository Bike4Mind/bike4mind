import { GAP_LOOKBACK_DAYS, PLATFORM_RULE, type ClientVerdict, type SideAppAlertRule } from './rules';

export type AlertPhase = 'open' | 'reminder' | 'resolved' | 'untracked';

const escapeMrkdwn = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const RULE_TEXT: Record<SideAppAlertRule | typeof PLATFORM_RULE, string> = {
  failing: 'requests are failing',
  silent: 'traffic has gone silent',
  [PLATFORM_RULE]: 'all connected apps are down',
};

const PHASE_PREFIX: Record<AlertPhase, string> = {
  open: 'Connected app alert',
  reminder: 'Connected app alert, still open',
  resolved: 'Connected app recovered',
  untracked: 'Connected app alert closed',
};

export interface SideAppAlertMessageInput {
  phase: AlertPhase;
  rule: SideAppAlertRule | typeof PLATFORM_RULE;
  appName?: string;
  /** Client id of the failing app; the link opens its drill-down. Omitted for the platform alert. */
  clientId?: string;
  verdict?: ClientVerdict;
  /** Names of the armed apps, for the platform alert. */
  armedAppNames?: string[];
  /** Origin of the app; the board link is omitted when unset. */
  appUrl?: string;
  stageLabel?: string;
  openedForMs?: number;
}

const formatHours = (hours: number) => `${Math.round(hours * 10) / 10}h`;
const formatOpenFor = (ms: number) => (ms < 60 * 60 * 1000 ? 'under 1h' : formatHours(ms / (60 * 60 * 1000)));

/** Slack mrkdwn for one alert. Carries counts and failure reasons only, never user identifiers. */
export function formatSideAppAlertMessage(input: SideAppAlertMessageInput): { text: string; blocks: unknown[] } {
  const { phase, rule, verdict } = input;
  const subject = rule === PLATFORM_RULE ? 'Side apps' : escapeMrkdwn(input.appName ?? 'Unknown app');
  const stage = input.stageLabel ? ` [${escapeMrkdwn(input.stageLabel)}]` : '';
  const what = phase === 'untracked' ? `no traffic for ${GAP_LOOKBACK_DAYS} days` : RULE_TEXT[rule];
  const headline = `${PHASE_PREFIX[phase]}${stage}: ${subject}, ${what}`;
  const lines: string[] = [`*${headline}*`];

  if (phase === 'untracked') {
    lines.push(`The app has had no traffic for ${GAP_LOOKBACK_DAYS} days. The alert is closed without a recovery.`);
  } else if (phase !== 'resolved') {
    if (rule === PLATFORM_RULE) {
      const names = (input.armedAppNames ?? []).map(escapeMrkdwn);
      lines.push(`Every armed app is failing or silent: ${names.join(', ') || 'none listed'}.`);
    } else if (verdict) {
      const { lastHour } = verdict;
      const attempts = lastHour.successes + lastHour.failures;
      lines.push(
        `Last hour: ${attempts} attempts, ${lastHour.successes} succeeded, ${lastHour.failures} failed (${lastHour.ourFaultFailures} on our side).`
      );
      if (rule === 'silent' && verdict.hoursSinceSuccess !== null) {
        lines.push(
          `No success for ${formatHours(verdict.hoursSinceSuccess)}; alert threshold ${formatHours(verdict.silenceThresholdHours)}.`
        );
      }
      if (verdict.topReasons.length) {
        lines.push(
          `Top failure reasons: ${verdict.topReasons.map(({ reason, count }) => `${escapeMrkdwn(reason)} (${count})`).join(', ')}.`
        );
      }
    }
  } else if (input.openedForMs !== undefined) {
    lines.push(`It was open for ${formatOpenFor(input.openedForMs)}.`);
  }

  if (input.appUrl) {
    const boardUrl = `${input.appUrl.replace(/\/$/, '')}/admin?tab=credit-analytics&creditTab=side-apps`;
    lines.push(
      rule !== PLATFORM_RULE && input.clientId
        ? `<${boardUrl}&sideApp=${encodeURIComponent(input.clientId)}|Open ${subject} on the Side apps board>`
        : `<${boardUrl}|Open the Side apps board>`
    );
  }
  const text = lines.join('\n');
  return { text: headline.replace(/[*]/g, ''), blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

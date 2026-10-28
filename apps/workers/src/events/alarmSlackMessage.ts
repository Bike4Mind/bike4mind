/**
 * Slack rendering for CloudWatch alarm notifications, shared by the alarm relay Lambdas.
 * Pure: no sst or AWS SDK import, so it is testable without mocking resources.
 *
 * Layout: a top-level header carries stage and level at a glance; the details sit in a
 * colour-barred attachment (red page / amber warn / blue info on production, grey on any other
 * stage, green when resolved). Mentions only ever apply to production page-level alarms.
 */

import { classifyStage } from '@bike4mind/common';
import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

export type AlarmLevel = 'page' | 'warn' | 'info';

export type AlarmLinkKey =
  | 'signup-activity'
  | 'waf-block-list'
  | 'dlq-replay'
  | 'live-ops-triage'
  | 'agent-executions'
  | 'integration-health'
  | 'system-secrets'
  | 'rate-limits';

export interface AlarmCatalogEntry {
  title: string;
  level: AlarmLevel;
  meaning: string;
  action: string;
  /** Short noun for the metric count, used in the "what happened" sentence. */
  unit?: string;
  /** Admin pages the "what to do" text points at; rendered as buttons when the app URL is known. */
  links?: AlarmLinkKey[];
}

export interface FormatOptions {
  /** Origin of the app (https://app.example.com). Admin buttons are omitted when unset. */
  appUrl?: string;
  /** Slack mention token such as <!channel>; applied to production page-level alarms only. */
  mention?: string;
}

export interface SlackAttachment {
  color: string;
  blocks: unknown[];
}

export interface SlackAlarmMessage {
  text: string;
  blocks: unknown[];
  attachments?: SlackAttachment[];
}

/** Admin console pages, by key. Paths are relative to the app origin. */
export const ADMIN_LINKS: Record<AlarmLinkKey, { label: string; path: string }> = {
  'signup-activity': { label: 'Signup activity', path: '/admin?tab=users&recentSignups=hour' },
  'waf-block-list': { label: 'WAF block list', path: '/admin?tab=security-dashboard' },
  'dlq-replay': { label: 'DLQ replay', path: '/admin?tab=dlq-replay' },
  'live-ops-triage': { label: 'LiveOps triage', path: '/admin?tab=live-ops-triage' },
  'agent-executions': { label: 'Agent executions', path: '/admin?tab=agent-executions' },
  'integration-health': { label: 'Integration health', path: '/admin?tab=integration-health' },
  'system-secrets': { label: 'System secrets', path: '/admin?tab=system-secrets' },
  'rate-limits': { label: 'Rate limits', path: '/admin?tab=rate-limits' },
};

const SIGNUP_ACTION =
  'Check the admin signup activity for the last hour and the WAF block list. If the senders are bots, block their IPs or email domains.';
const SIGNUP_LINKS: AlarmLinkKey[] = ['signup-activity', 'waf-block-list'];
const BLOCKER_LOG_ACTION = 'Check the blocker Lambda log and its dead-letter queue.';

export const ALARM_CATALOG: Record<string, AlarmCatalogEntry> = {
  'signup-code-send-rate': {
    title: 'Sign-in code emails above the hourly ceiling',
    level: 'warn',
    unit: 'sign-in code emails',
    meaning:
      'More sign-in code emails went out in one hour than we expect from normal signups and logins. This usually means automated signups.',
    action: SIGNUP_ACTION,
    links: SIGNUP_LINKS,
  },
  'signup-code-send-burst': {
    title: 'Sign-in code emails spiking',
    level: 'page',
    unit: 'sign-in code emails',
    meaning:
      'A burst of sign-in code emails went out in five minutes, far above normal. Automated signups are the usual cause.',
    action: SIGNUP_ACTION,
    links: SIGNUP_LINKS,
  },
  'api-key-create-burst': {
    title: 'API keys being created unusually fast',
    level: 'page',
    unit: 'API keys',
    meaning: 'Many user API keys were created in five minutes. Normal users create one occasionally.',
    action:
      'Check which accounts created the keys and whether they are new accounts. Revoke keys from accounts that look automated.',
    links: ['signup-activity'],
  },
  'ungranted-credit-purchases': {
    title: 'Customer paid but got no credits',
    level: 'page',
    unit: 'purchases',
    meaning: 'Stripe took a payment and the credits were not added to the account.',
    action:
      'Find the purchase in Stripe and the credit ledger, grant the credits by hand, then check the webhook handler logs.',
  },
  'billing-event-ingest-failures': {
    title: 'Billing events not reaching Overwatch',
    level: 'page',
    unit: 'billing events',
    meaning:
      'Usage and billing events are being dropped before they reach the billing system, so spend is under-counted.',
    action: 'Check the ingest endpoint and the worker logs, then replay the dropped events.',
  },
  'anthropic-rate-limit-errors': {
    title: 'Anthropic is rate limiting us',
    level: 'page',
    unit: 'rate limit errors',
    meaning:
      'Requests to Anthropic are being refused for exceeding our quota, even after retries. Users see failed chats.',
    action: 'Check current Anthropic usage against the quota. Reduce traffic or ask Anthropic for a higher limit.',
  },
  'agent-checkpoint-depth-warning': {
    title: 'An agent run is looping',
    level: 'warn',
    unit: 'runs',
    meaning:
      'An agent has handed off to itself more times than expected, which can mean it is stuck in a loop and burning credits.',
    action: 'Find the session in the agent executor logs and stop it if it is not making progress.',
    links: ['agent-executions'],
  },
  'agent-checkpoint-depth-exceeded': {
    title: 'An agent run was stopped for looping',
    level: 'warn',
    unit: 'runs',
    meaning: 'An agent hit the hard limit on self-handoffs and was stopped.',
    action: 'Review the session to see why it never finished.',
    links: ['agent-executions'],
  },
  'liveops-p0-issues': {
    title: 'LiveOps found a blocker issue',
    level: 'page',
    unit: 'issues',
    meaning: 'The automated triage created a P0 issue from production errors.',
    action: 'Open the newest P0 issue in the tracker and respond.',
    links: ['live-ops-triage'],
  },
  'liveops-p1-issues': {
    title: 'LiveOps found a critical issue',
    level: 'warn',
    unit: 'issues',
    meaning: 'The automated triage created a P1 issue from production errors.',
    action: 'Open the newest P1 issue in the tracker.',
    links: ['live-ops-triage'],
  },
  'liveops-high-error-volume': {
    title: 'Production error volume is high',
    level: 'page',
    unit: 'errors',
    meaning: 'Far more errors than usual were logged. Something may be broken for many users.',
    action: 'Check the latest deploy and the error log for a common cause.',
    links: ['live-ops-triage'],
  },
  'ecs-task-failed-to-start': {
    title: 'A background service cannot start',
    level: 'page',
    unit: 'services',
    meaning:
      'A long-running service has no running copies, so whatever it does (for example real-time updates) is down.',
    action: 'Check the service events in ECS for the reason it cannot start.',
  },
  'dlq-alarm-handler-dlq-messages': {
    title: 'Alarm delivery to Slack is failing',
    level: 'page',
    unit: 'messages',
    meaning: 'Alarms could not be posted to Slack, so other alarms may be going unseen.',
    action: 'Check the Slack webhook secrets and the alarm relay Lambda errors.',
    links: ['system-secrets'],
  },
  'waf-alarm-slack-handler-dlq-messages': {
    title: 'WAF alert delivery to Slack is failing',
    level: 'page',
    unit: 'messages',
    meaning: 'WAF alerts could not be posted to Slack, so abuse alerts may be going unseen.',
    action: 'Check the Slack webhook secrets and the WAF alarm relay Lambda errors.',
    links: ['system-secrets'],
  },
  'waf-otc-edge-signal-rate': {
    title: 'WAF is flagging many sign-in code requests',
    level: 'warn',
    unit: 'requests',
    meaning:
      'Many sign-in code requests in five minutes came from hosting providers or clients the WAF labels as bots. This usually means automated signups.',
    action: SIGNUP_ACTION,
    links: SIGNUP_LINKS,
  },
  'rate-limit-hit': {
    title: 'Integration API rate limit reached',
    level: 'warn',
    unit: 'rejected requests',
    meaning: 'An integration is making more calls than its limit allows and is getting rejected.',
    action: 'Identify the integration from the logs and slow it down or raise its limit.',
    links: ['rate-limits'],
  },
  'circuit-breaker-open': {
    title: 'An integration was cut off',
    level: 'page',
    unit: 'integrations',
    meaning: 'An external integration failed repeatedly, so we stopped calling it to protect the app.',
    action: 'Check which integration opened the breaker and whether the provider is down.',
    links: ['integration-health'],
  },
  'model-discovery-no-successful-run': {
    title: 'Model discovery has not completed a successful run',
    level: 'warn',
    unit: 'runs',
    meaning: 'The model catalog is not being refreshed, so new or changed models will not show up.',
    action: 'Check the model discovery job logs for the failure.',
  },
  'no-successful-run': {
    title: 'The WAF auto-blocker has stopped running',
    level: 'page',
    unit: 'runs',
    meaning:
      'The scheduled job that blocks abusive IPs has not completed a run in 30 minutes. New abusers are not being blocked automatically.',
    action: BLOCKER_LOG_ACTION,
  },
  'slow-no-successful-run': {
    title: "The WAF auto-blocker's daily sweep has stopped",
    level: 'warn',
    unit: 'runs',
    meaning: 'The long-window sweep of the auto-blocker has not completed in 7 hours.',
    action: BLOCKER_LOG_ACTION,
  },
  'cap-exceeded': {
    title: 'The WAF auto-blocker found more abusers than it is allowed to block',
    level: 'warn',
    unit: 'IPs',
    meaning:
      'One run found more new abusive IPs than its safety cap, so it held back rather than blocking a large batch blindly.',
    action: 'Review the IP list in the blocker log. Raise the cap if they are genuine.',
  },
  'query-failure': {
    title: 'The WAF auto-blocker cannot read the logs',
    level: 'warn',
    unit: 'failed runs',
    meaning: 'Two runs in a row failed to query the WAF logs. The block list is unchanged.',
    action: 'Check the blocker Lambda log for the query error.',
  },
  'set-size': {
    title: 'The WAF block list is very large',
    level: 'warn',
    unit: 'blocked IPs',
    meaning: 'The auto-blocker holds more entries than expected.',
    action: 'Review the entries for mistakes before they expire on their own.',
    links: ['waf-block-list'],
  },
  'slow-errors': {
    title: 'A WAF auto-blocker daily sweep failed',
    level: 'warn',
    unit: 'failed runs',
    meaning: 'A long-window run failed. The block list is unchanged.',
    action: 'Check the blocker Lambda log.',
  },
};

/** Level for alarms the catalog does not know. */
export const DEFAULT_ALARM_LEVEL: AlarmLevel = 'warn';

const COLOR = {
  page: '#E01E5A',
  warn: '#ECB22E',
  info: '#36C5F0',
  nonprod: '#9AA5B1',
  resolved: '#2EB67D',
} as const;

const PRODUCTION_PREFIX: Record<AlarmLevel, string> = {
  page: ':rotating_light: PRODUCTION ALARM',
  warn: ':warning: Production warning',
  info: ':information_source: Production notice',
};

const STAGE_ALIASES = ['prod', 'production', 'dev', 'staging'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEPARATOR = '  |  ';

export function isCloudWatchAlarm(payload: unknown): payload is CloudWatchAlarmPayload {
  return typeof (payload as CloudWatchAlarmPayload | null)?.NewStateValue === 'string';
}

export const isProductionStage = (stage: string) => classifyStage(stage) === 'production';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strips the leading `<app>-<stage>-` from an alarm name; returns the whole name when none matches. */
export function alarmSuffix(alarmName: string, stage: string): string {
  const stages = [stage, ...STAGE_ALIASES].map(escapeRegExp).join('|');
  const match = new RegExp(`^(.*?)-(?:${stages})-(.+)$`).exec(alarmName);
  return match ? match[2] : alarmName;
}

/** Exact match first, then the longest catalog key the suffix starts or ends with. */
export function lookupCatalog(suffix: string): AlarmCatalogEntry | undefined {
  if (Object.prototype.hasOwnProperty.call(ALARM_CATALOG, suffix)) return ALARM_CATALOG[suffix];
  let best: string | undefined;
  for (const key of Object.keys(ALARM_CATALOG)) {
    if (suffix.startsWith(key) || suffix.endsWith(key)) {
      if (best === undefined || key.length > best.length) best = key;
    }
  }
  return best === undefined ? undefined : ALARM_CATALOG[best];
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const formatClock = (d: Date) => `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;

function parseStateChangeTime(value: string): Date | undefined {
  const d = new Date((value ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function periodPhrase(periodSeconds: number): string {
  if (periodSeconds === 3600) return 'hour';
  if (periodSeconds === 86400) return 'day';
  const minutes = Math.round(periodSeconds / 60);
  return minutes === 1 ? 'minute' : `${minutes} minutes`;
}

/** "5 min", "1 h 10 min"; under a minute rounds up so a fresh breach never reads as zero. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}

/** Slack mrkdwn treats &, < and > as control characters; escape them in interpolated text. */
export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatNumber = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : raw;
};

const DATAPOINT_RE = /([-+\d.eE]+) \((\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\)/g;

export type ParsedReason =
  | {
      kind: 'threshold';
      value: string;
      threshold?: string;
      limit: 'ceiling' | 'floor';
      /** Epoch ms of the newest and oldest breaching datapoint windows. */
      latestStart: number;
      earliestStart: number;
      period?: number;
    }
  | { kind: 'missing'; minutes?: number }
  | { kind: 'raw'; reason: string };

/** Pulls the numbers out of CloudWatch's NewStateReason prose. */
export function parseReason(alarm: CloudWatchAlarmPayload): ParsedReason {
  const reason = alarm.NewStateReason ?? '';
  const trigger = alarm.Trigger;

  // A reason can list real datapoints and missing ones together ("1 out of the last 3 datapoints
  // [...] ... and 2 missing datapoints were treated as [Breaching]"); the real value wins then.
  const points = /^Threshold Crossed/i.test(reason)
    ? [...reason.matchAll(DATAPOINT_RE)].map(([, rawValue, dd, mm, yy, hh, mi, ss]) => ({
        rawValue,
        start: Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)),
      }))
    : [];

  if (points.length > 0) {
    // Pick by timestamp, not position: CloudWatch lists the newest datapoint first.
    const latest = points.reduce((a, b) => (b.start > a.start ? b : a));
    const earliest = points.reduce((a, b) => (b.start < a.start ? b : a));
    const thresholdMatch = /threshold \(([^)]+)\)/i.exec(reason);
    return {
      kind: 'threshold',
      value: formatNumber(latest.rawValue),
      threshold: thresholdMatch ? formatNumber(thresholdMatch[1]) : undefined,
      limit: /less than/i.test(reason) ? 'floor' : 'ceiling',
      latestStart: latest.start,
      earliestStart: earliest.start,
      period: trigger?.Period,
    };
  }

  if (/missing datapoint|datapoints? (?:was|were) missing|no datapoints were received/i.test(reason)) {
    const minutes =
      trigger?.EvaluationPeriods && trigger.Period
        ? Math.round((trigger.EvaluationPeriods * trigger.Period) / 60)
        : undefined;
    return { kind: 'missing', minutes };
  }

  return { kind: 'raw', reason };
}

export function describeReason(alarm: CloudWatchAlarmPayload, unit?: string): string {
  const parsed = parseReason(alarm);
  if (parsed.kind === 'missing') {
    return parsed.minutes === undefined
      ? 'No data arrived for a while.'
      : `No data arrived for ${parsed.minutes} minutes, which counts as a failure for this alarm.`;
  }
  if (parsed.kind === 'raw') return parsed.reason;

  const what = unit ? `${parsed.value} ${unit}` : `The value was ${parsed.value}`;
  const when = parsed.period
    ? ` in the ${periodPhrase(parsed.period)} ending ${formatClock(new Date(parsed.latestStart + parsed.period * 1000))} UTC`
    : ` at ${formatClock(new Date(parsed.latestStart))} UTC`;
  const threshold = parsed.threshold ? `; the ${parsed.limit} is ${parsed.threshold}` : '';
  return `${what}${when}${threshold}.`;
}

/** Field cells for the numbers-at-a-glance block; empty when the reason carries no numbers. */
export function describeFields(alarm: CloudWatchAlarmPayload, unit?: string, changedAt?: Date): string[] {
  const parsed = parseReason(alarm);
  const fields: string[] = [];
  let sinceMs: number | undefined;

  if (parsed.kind === 'threshold') {
    fields.push(`*Measured*\n${parsed.value}${unit ? ` ${unit}` : ''}`);
    if (parsed.threshold) fields.push(`*${parsed.limit === 'floor' ? 'Floor' : 'Ceiling'}*\n${parsed.threshold}`);
    fields.push(
      parsed.period
        ? `*Window*\n${periodPhrase(parsed.period)} ending ${formatClock(new Date(parsed.latestStart + parsed.period * 1000))} UTC`
        : `*At*\n${formatClock(new Date(parsed.latestStart))} UTC`
    );
    sinceMs = parsed.earliestStart;
  } else if (parsed.kind === 'missing') {
    if (parsed.minutes !== undefined) {
      fields.push(`*Missing data for*\n${parsed.minutes} min`);
      if (changedAt) sinceMs = changedAt.getTime() - parsed.minutes * 60_000;
    }
  }

  if (sinceMs !== undefined) {
    const since = new Date(sinceMs);
    const duration =
      changedAt && changedAt.getTime() > sinceMs ? ` (${formatDuration(changedAt.getTime() - sinceMs)})` : '';
    fields.push(`*Breaching since*\n${formatClock(since)} UTC${duration}`);
  }
  return fields;
}

function resolveEntry(alarm: CloudWatchAlarmPayload, stage: string) {
  const suffix = alarmSuffix(alarm.AlarmName, stage);
  const entry = lookupCatalog(suffix);
  if (entry) return { entry, title: entry.title, level: entry.level };
  const words = suffix.replace(/-/g, ' ');
  return { entry: undefined, title: words.charAt(0).toUpperCase() + words.slice(1), level: DEFAULT_ALARM_LEVEL };
}

export function consoleUrl(alarm: CloudWatchAlarmPayload): string | undefined {
  if (!alarm.Region || !alarm.AlarmName) return undefined;
  const name = encodeURIComponent(alarm.AlarmName);
  return `https://${alarm.Region}.console.aws.amazon.com/cloudwatch/home?region=${alarm.Region}#alarmsV2:alarm/${name}`;
}

/**
 * Turns an operator-supplied mention setting into a Slack mention token, or undefined when it
 * is off or unusable. Accepts the raw token (<!channel>, <!subteam^S123>, <@U123>), the words
 * channel / here / everyone, or a bare user (U...), bot (W...) or user-group (S...) id.
 */
export function normalizeMentionToken(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value || ['off', 'none', 'false', '0', 'not-configured'].includes(value.toLowerCase())) return undefined;
  const word = value.replace(/^@/, '').toLowerCase();
  if (word === 'channel' || word === 'here' || word === 'everyone') return `<!${word}>`;
  if (/^<[!@][^<>\s]+>$/.test(value)) return value;
  if (/^[UW][A-Z0-9]{2,}$/.test(value)) return `<@${value}>`;
  if (/^S[A-Z0-9]{2,}$/.test(value)) return `<!subteam^${value}>`;
  return undefined;
}

export interface ComposeParams {
  stage: string;
  level: AlarmLevel;
  /** Raw text: it goes into a plain_text header, and is escaped for the mrkdwn fallback. */
  title: string;
  /** Mention token; only honoured on production page-level messages. */
  mention?: string;
  /** mrkdwn field cells (two per row). */
  fields?: string[];
  /** mrkdwn sections, already escaped. */
  sections: string[];
  buttons?: { label: string; url: string }[];
  /** Footer fragments, already escaped. */
  context: string[];
  /** The notification/fallback body, appended to the header text. */
  summary: string;
}

/** Assembles the header + colour-barred attachment shape every alarm-style message uses. */
export function composeAlarmMessage(params: ComposeParams): SlackAlarmMessage {
  const production = isProductionStage(params.stage);
  const prefix = production ? PRODUCTION_PREFIX[params.level] : `:small_blue_diamond: ${params.stage} alarm`;
  const color = production ? COLOR[params.level] : COLOR.nonprod;
  const headerText = `${prefix}: ${params.title}`;
  const mention = production && params.level === 'page' ? normalizeMentionToken(params.mention) : undefined;

  const blocks: unknown[] = [];
  if (mention) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${mention} production is paging` } });
  }
  blocks.push({ type: 'header', text: { type: 'plain_text', text: headerText.slice(0, 150), emoji: true } });

  const body: unknown[] = [];
  if (params.fields && params.fields.length > 0) {
    body.push({
      type: 'section',
      fields: params.fields.slice(0, 10).map(text => ({ type: 'mrkdwn', text })),
    });
  }
  for (const text of params.sections) body.push({ type: 'section', text: { type: 'mrkdwn', text } });
  if (params.buttons && params.buttons.length > 0) {
    body.push({
      type: 'actions',
      elements: params.buttons.slice(0, 5).map((button, index) => ({
        type: 'button',
        text: { type: 'plain_text', text: button.label.slice(0, 75), emoji: true },
        url: button.url,
        action_id: `alarm-link-${index}`,
      })),
    });
  }
  body.push({ type: 'context', elements: [{ type: 'mrkdwn', text: params.context.join(SEPARATOR) }] });

  return {
    text: `${mention ? `${mention} ` : ''}${escapeMrkdwn(headerText)}: ${escapeMrkdwn(params.summary)}`,
    blocks,
    attachments: [{ color, blocks: body }],
  };
}

/** Returns null for INSUFFICIENT_DATA, which is not worth a channel message. */
export function formatAlarmSlackMessage(
  alarm: CloudWatchAlarmPayload,
  stage: string,
  options: FormatOptions = {}
): SlackAlarmMessage | null {
  if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') return null;

  const { entry, title, level } = resolveEntry(alarm, stage);
  const when = parseStateChangeTime(alarm.StateChangeTime);
  const url = consoleUrl(alarm);
  const link = url ? `<${url}|Open in CloudWatch>` : undefined;

  if (alarm.NewStateValue === 'OK') {
    const back = when ? `back to normal at ${formatClock(when)} UTC` : 'back to normal';
    const text = `:white_check_mark: Resolved: ${escapeMrkdwn(title)}`;
    const context = [escapeMrkdwn(alarm.AlarmName), link].filter(Boolean) as string[];
    return {
      text,
      blocks: [],
      attachments: [
        {
          color: COLOR.resolved,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:white_check_mark: *Resolved: ${escapeMrkdwn(title)}*\n${escapeMrkdwn(stage)}${SEPARATOR}${back}`,
              },
            },
            { type: 'context', elements: [{ type: 'mrkdwn', text: context.join(SEPARATOR) }] },
          ],
        },
      ],
    };
  }

  const happened = describeReason(alarm, entry?.unit);
  const why = entry?.meaning ?? alarm.AlarmDescription;
  const sections = [`*What happened*\n${escapeMrkdwn(happened)}`];
  if (why) sections.push(`*Why it matters*\n${escapeMrkdwn(why)}`);
  if (entry?.action) sections.push(`*What to do*\n${escapeMrkdwn(entry.action)}`);

  const buttons: { label: string; url: string }[] = [];
  if (url) buttons.push({ label: 'Open in CloudWatch', url });
  const appUrl = options.appUrl?.replace(/\/+$/, '');
  if (appUrl) {
    for (const key of entry?.links ?? []) {
      buttons.push({ label: ADMIN_LINKS[key].label, url: `${appUrl}${ADMIN_LINKS[key].path}` });
    }
  }

  const stamp = when ? `${formatClock(when)} UTC, ${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]}` : undefined;
  const context = [escapeMrkdwn(stage), `level ${level}`, escapeMrkdwn(alarm.AlarmName), stamp].filter(
    Boolean
  ) as string[];

  return composeAlarmMessage({
    stage,
    level,
    title,
    mention: options.mention,
    fields: describeFields(alarm, entry?.unit, when),
    sections,
    buttons,
    context,
    summary: happened,
  });
}

/** The alarms channel when its secret is configured, otherwise the error-reporting channel. */
export function resolveAlarmWebhookUrl(resource: {
  SLACK_ALARMS_WEBHOOK_URL?: { value?: string };
  SLACK_ERROR_REPORTING_WEBHOOK_URL: { value: string };
}): string {
  const alarms = resource.SLACK_ALARMS_WEBHOOK_URL?.value;
  if (alarms && alarms !== 'not-configured') return alarms;
  return resource.SLACK_ERROR_REPORTING_WEBHOOK_URL.value;
}

/** App origin for admin buttons, derived the same way the rest of the server does (app.<apex>). */
export function appUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const domain = env.SERVER_DOMAIN?.trim();
  return domain ? `https://app.${domain}` : undefined;
}

export async function postAlarmToSlack(webhookUrl: string, message: SlackAlarmMessage): Promise<void> {
  const body: Record<string, unknown> = { text: message.text };
  if (message.blocks.length > 0) body.blocks = message.blocks;
  if (message.attachments && message.attachments.length > 0) body.attachments = message.attachments;
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook failed: ${resp.status} ${resp.statusText}`);
  }
}

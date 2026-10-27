/**
 * Plain-English Slack rendering for CloudWatch alarm notifications, shared by the alarm relay
 * Lambdas. Pure: no sst import, so it is testable without mocking resources.
 */

import type { CloudWatchAlarmPayload } from './cloudwatchAlarmTypes';

export type AlarmSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AlarmCatalogEntry {
  title: string;
  severity: AlarmSeverity;
  meaning: string;
  action: string;
  /** Short noun for the metric count, used in the "what happened" sentence. */
  unit?: string;
}

export interface SlackAlarmMessage {
  text: string;
  blocks: unknown[];
}

const SIGNUP_ACTION =
  'Check the admin signup activity for the last hour and the WAF block list. If the senders are bots, block their IPs or email domains.';
const BLOCKER_LOG_ACTION = 'Check the blocker Lambda log and its dead-letter queue.';

export const ALARM_CATALOG: Record<string, AlarmCatalogEntry> = {
  'signup-code-send-rate': {
    title: 'Sign-in code emails above the hourly ceiling',
    severity: 'medium',
    unit: 'sign-in code emails',
    meaning:
      'More sign-in code emails went out in one hour than we expect from normal signups and logins. This usually means automated signups.',
    action: SIGNUP_ACTION,
  },
  'signup-code-send-burst': {
    title: 'Sign-in code emails spiking',
    severity: 'high',
    unit: 'sign-in code emails',
    meaning:
      'A burst of sign-in code emails went out in five minutes, far above normal. Automated signups are the usual cause.',
    action: SIGNUP_ACTION,
  },
  'api-key-create-burst': {
    title: 'API keys being created unusually fast',
    severity: 'high',
    unit: 'API keys',
    meaning: 'Many user API keys were created in five minutes. Normal users create one occasionally.',
    action:
      'Check which accounts created the keys and whether they are new accounts. Revoke keys from accounts that look automated.',
  },
  'ungranted-credit-purchases': {
    title: 'Customer paid but got no credits',
    severity: 'critical',
    unit: 'purchases',
    meaning: 'Stripe took a payment and the credits were not added to the account.',
    action:
      'Find the purchase in Stripe and the credit ledger, grant the credits by hand, then check the webhook handler logs.',
  },
  'billing-event-ingest-failures': {
    title: 'Billing events not reaching Overwatch',
    severity: 'high',
    unit: 'billing events',
    meaning:
      'Usage and billing events are being dropped before they reach the billing system, so spend is under-counted.',
    action: 'Check the ingest endpoint and the worker logs, then replay the dropped events.',
  },
  'anthropic-rate-limit-errors': {
    title: 'Anthropic is rate limiting us',
    severity: 'high',
    unit: 'rate limit errors',
    meaning:
      'Requests to Anthropic are being refused for exceeding our quota, even after retries. Users see failed chats.',
    action: 'Check current Anthropic usage against the quota. Reduce traffic or ask Anthropic for a higher limit.',
  },
  'agent-checkpoint-depth-warning': {
    title: 'An agent run is looping',
    severity: 'medium',
    unit: 'runs',
    meaning:
      'An agent has handed off to itself more times than expected, which can mean it is stuck in a loop and burning credits.',
    action: 'Find the session in the agent executor logs and stop it if it is not making progress.',
  },
  'agent-checkpoint-depth-exceeded': {
    title: 'An agent run was stopped for looping',
    severity: 'high',
    unit: 'runs',
    meaning: 'An agent hit the hard limit on self-handoffs and was stopped.',
    action: 'Review the session to see why it never finished.',
  },
  'liveops-p0-issues': {
    title: 'LiveOps found a blocker issue',
    severity: 'critical',
    unit: 'issues',
    meaning: 'The automated triage created a P0 issue from production errors.',
    action: 'Open the newest P0 issue in the tracker and respond.',
  },
  'liveops-p1-issues': {
    title: 'LiveOps found a critical issue',
    severity: 'high',
    unit: 'issues',
    meaning: 'The automated triage created a P1 issue from production errors.',
    action: 'Open the newest P1 issue in the tracker.',
  },
  'liveops-high-error-volume': {
    title: 'Production error volume is high',
    severity: 'high',
    unit: 'errors',
    meaning: 'Far more errors than usual were logged. Something may be broken for many users.',
    action: 'Check the latest deploy and the error log for a common cause.',
  },
  'ecs-task-failed-to-start': {
    title: 'A background service cannot start',
    severity: 'critical',
    unit: 'services',
    meaning:
      'A long-running service has no running copies, so whatever it does (for example real-time updates) is down.',
    action: 'Check the service events in ECS for the reason it cannot start.',
  },
  'dlq-alarm-handler-dlq-messages': {
    title: 'Alarm delivery to Slack is failing',
    severity: 'high',
    unit: 'messages',
    meaning: 'Alarms could not be posted to Slack, so other alarms may be going unseen.',
    action: 'Check the Slack webhook secrets and the alarm relay Lambda errors.',
  },
  'waf-alarm-slack-handler-dlq-messages': {
    title: 'WAF alert delivery to Slack is failing',
    severity: 'high',
    unit: 'messages',
    meaning: 'WAF alerts could not be posted to Slack, so abuse alerts may be going unseen.',
    action: 'Check the Slack webhook secrets and the WAF alarm relay Lambda errors.',
  },
  'waf-otc-edge-signal-rate': {
    title: 'WAF is flagging many sign-in code requests',
    severity: 'medium',
    unit: 'requests',
    meaning:
      'Many sign-in code requests in five minutes came from hosting providers or clients the WAF labels as bots. This usually means automated signups.',
    action: SIGNUP_ACTION,
  },
  'rate-limit-hit': {
    title: 'Integration API rate limit reached',
    severity: 'medium',
    unit: 'rejected requests',
    meaning: 'An integration is making more calls than its limit allows and is getting rejected.',
    action: 'Identify the integration from the logs and slow it down or raise its limit.',
  },
  'circuit-breaker-open': {
    title: 'An integration was cut off',
    severity: 'high',
    unit: 'integrations',
    meaning: 'An external integration failed repeatedly, so we stopped calling it to protect the app.',
    action: 'Check which integration opened the breaker and whether the provider is down.',
  },
  'model-discovery-no-successful-run': {
    title: 'Model discovery has not completed a successful run',
    severity: 'medium',
    unit: 'runs',
    meaning: 'The model catalog is not being refreshed, so new or changed models will not show up.',
    action: 'Check the model discovery job logs for the failure.',
  },
  'no-successful-run': {
    title: 'The WAF auto-blocker has stopped running',
    severity: 'high',
    unit: 'runs',
    meaning:
      'The scheduled job that blocks abusive IPs has not completed a run in 30 minutes. New abusers are not being blocked automatically.',
    action: BLOCKER_LOG_ACTION,
  },
  'slow-no-successful-run': {
    title: "The WAF auto-blocker's daily sweep has stopped",
    severity: 'medium',
    unit: 'runs',
    meaning: 'The long-window sweep of the auto-blocker has not completed in 7 hours.',
    action: BLOCKER_LOG_ACTION,
  },
  'cap-exceeded': {
    title: 'The WAF auto-blocker found more abusers than it is allowed to block',
    severity: 'high',
    unit: 'IPs',
    meaning:
      'One run found more new abusive IPs than its safety cap, so it held back rather than blocking a large batch blindly.',
    action: 'Review the IP list in the blocker log. Raise the cap if they are genuine.',
  },
  'query-failure': {
    title: 'The WAF auto-blocker cannot read the logs',
    severity: 'medium',
    unit: 'failed runs',
    meaning: 'Two runs in a row failed to query the WAF logs. The block list is unchanged.',
    action: 'Check the blocker Lambda log for the query error.',
  },
  'set-size': {
    title: 'The WAF block list is very large',
    severity: 'medium',
    unit: 'blocked IPs',
    meaning: 'The auto-blocker holds more entries than expected.',
    action: 'Review the entries for mistakes before they expire on their own.',
  },
  'slow-errors': {
    title: 'A WAF auto-blocker daily sweep failed',
    severity: 'medium',
    unit: 'failed runs',
    meaning: 'A long-window run failed. The block list is unchanged.',
    action: 'Check the blocker Lambda log.',
  },
};

const SEVERITY_EMOJI: Record<AlarmSeverity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const STAGE_ALIASES = ['prod', 'production', 'dev', 'staging'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isCloudWatchAlarm(payload: unknown): payload is CloudWatchAlarmPayload {
  return typeof (payload as CloudWatchAlarmPayload | null)?.NewStateValue === 'string';
}

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

/** Slack mrkdwn treats &, < and > as control characters; escape them in interpolated text. */
export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const formatNumber = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : raw;
};

const DATAPOINT_RE = /([-+\d.eE]+) \((\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})\)/g;

export function describeReason(alarm: CloudWatchAlarmPayload, unit?: string): string {
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

  if (
    points.length === 0 &&
    /missing datapoint|datapoints? (?:was|were) missing|no datapoints were received/i.test(reason)
  ) {
    if (trigger?.EvaluationPeriods && trigger.Period) {
      const minutes = Math.round((trigger.EvaluationPeriods * trigger.Period) / 60);
      return `No data arrived for ${minutes} minutes, which counts as a failure for this alarm.`;
    }
    return 'No data arrived for a while.';
  }

  if (points.length > 0) {
    // Pick by timestamp, not position: CloudWatch lists the newest datapoint first.
    const latest = points.reduce((a, b) => (b.start > a.start ? b : a));
    const value = formatNumber(latest.rawValue);
    const what = unit ? `${value} ${unit}` : `The value was ${value}`;
    const period = trigger?.Period;
    const when = period
      ? ` in the ${periodPhrase(period)} ending ${formatClock(new Date(latest.start + period * 1000))} UTC`
      : ` at ${formatClock(new Date(latest.start))} UTC`;
    const thresholdMatch = /threshold \(([^)]+)\)/i.exec(reason);
    const limit = /less than/i.test(reason) ? 'floor' : 'ceiling';
    const threshold = thresholdMatch ? `; the ${limit} is ${formatNumber(thresholdMatch[1])}` : '';
    return `${what}${when}${threshold}.`;
  }

  return reason;
}

function resolveEntry(alarm: CloudWatchAlarmPayload, stage: string) {
  const entry = lookupCatalog(alarmSuffix(alarm.AlarmName, stage));
  if (entry) return { entry, title: entry.title, emoji: SEVERITY_EMOJI[entry.severity] };
  const words = alarmSuffix(alarm.AlarmName, stage).replace(/-/g, ' ');
  return { entry: undefined, title: words.charAt(0).toUpperCase() + words.slice(1), emoji: SEVERITY_EMOJI.high };
}

function consoleLink(alarm: CloudWatchAlarmPayload): string | undefined {
  if (!alarm.Region || !alarm.AlarmName) return undefined;
  const name = encodeURIComponent(alarm.AlarmName);
  return `<https://${alarm.Region}.console.aws.amazon.com/cloudwatch/home?region=${alarm.Region}#alarmsV2:alarm/${name}|Open in CloudWatch>`;
}

/** Returns null for INSUFFICIENT_DATA, which is not worth a channel message. */
export function formatAlarmSlackMessage(alarm: CloudWatchAlarmPayload, stage: string): SlackAlarmMessage | null {
  if (alarm.NewStateValue !== 'ALARM' && alarm.NewStateValue !== 'OK') return null;

  const { entry, title, emoji } = resolveEntry(alarm, stage);
  const when = parseStateChangeTime(alarm.StateChangeTime);
  const link = consoleLink(alarm);

  if (alarm.NewStateValue === 'OK') {
    const back = when ? `back to normal at ${formatClock(when)} UTC` : 'back to normal';
    const context = [escapeMrkdwn(`${stage} · ${alarm.AlarmName}`), link].filter(Boolean).join(' · ');
    return {
      text: escapeMrkdwn(`✅ Resolved: ${title}`),
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `✅ *Resolved: ${escapeMrkdwn(title)}*\n${escapeMrkdwn(stage)} · ${back}` },
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
      ],
    };
  }

  const happened = describeReason(alarm, entry?.unit);
  const why = entry?.meaning ?? alarm.AlarmDescription;
  const parts = [`*What happened*\n${escapeMrkdwn(happened)}`];
  if (why) parts.push(`*Why it matters*\n${escapeMrkdwn(why)}`);
  if (entry?.action) parts.push(`*What to do*\n${escapeMrkdwn(entry.action)}`);

  const stamp = when ? `${formatClock(when)} UTC, ${when.getUTCDate()} ${MONTHS[when.getUTCMonth()]}` : undefined;
  const context = [escapeMrkdwn(`${stage} · ${alarm.AlarmName}`), stamp, link].filter(Boolean).join(' · ');

  return {
    text: escapeMrkdwn(`${emoji} ${title}: ${happened}`),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `${emoji} ${title}`.slice(0, 150), emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: parts.join('\n\n') } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: context }] },
    ],
  };
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

export async function postAlarmToSlack(webhookUrl: string, message: SlackAlarmMessage): Promise<void> {
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message.text, blocks: message.blocks }),
  });
  if (!resp.ok) {
    throw new Error(`Slack webhook failed: ${resp.status} ${resp.statusText}`);
  }
}

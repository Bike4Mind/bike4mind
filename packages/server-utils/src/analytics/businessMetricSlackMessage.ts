/**
 * One Slack message per cron run, grouping every anomaly the run found. Same shape as the
 * CloudWatch alarm relay (apps/workers/src/events/alarmSlackMessage.ts): a plain-English
 * header, a colour-barred attachment with one section per metric, admin buttons and a category
 * footer. Pure: no database or sst import.
 *
 * Contributors never appear as raw ids. Users and organizations become admin links labelled
 * by the tail of the id, models by their display name, at most three per metric; see
 * describeContributors for the one-each case (signups, active users).
 */

import type { BusinessMetricAnomaly, ComparisonWindow, MetricContributor } from './businessMetricAnomalies';
import { HOUR_MS } from './businessMetricAnomalies';
import {
  describeMetric,
  formatMetricDelta,
  formatMetricValue,
  metricMeaning,
  metricSignal,
  modelDisplayName,
  type MetricDescription,
  type MetricSignal,
} from './businessMetricLabels';

export interface BusinessMetricMessageOptions {
  /** Origin of the app (https://app.example.com). Admin links and buttons are omitted when unset. */
  appUrl?: string;
  /** Already-humanised stage name for the footer ("production", "staging"). */
  stage?: string;
}

export interface BusinessMetricSlackMessage {
  text: string;
  blocks: unknown[];
  attachments: { color: string; blocks: unknown[] }[];
}

export const MAX_CONTRIBUTORS = 3;
const MAX_SECTIONS = 40;
const SEPARATOR = '  |  ';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COLOR: Record<MetricSignal, string> = { abuse: '#E01E5A', dip: '#ECB22E', growth: '#36C5F0' };
const SIGNAL_RANK: Record<MetricSignal, number> = { abuse: 0, dip: 1, growth: 2 };
const GLYPH: Record<MetricSignal, string> = {
  abuse: ':small_red_triangle:',
  dip: ':small_red_triangle_down:',
  growth: ':arrow_up_small:',
};

export const escapeMrkdwn = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const clock = (at: Date) =>
  `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}`;
const dayLabel = (at: Date) => `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;

/** "16:00 UTC intraday compare" or "2 Nov closed-day compare", for the title. */
export function describeWindow(window: ComparisonWindow): string {
  if (window.mode === 'daily') return `${dayLabel(new Date(window.end.getTime() - 1))} closed-day compare`;
  return `${clock(window.end)} UTC intraday compare`;
}

/** The sentence under the header that says what "current" and "previous" are. */
export function explainWindow(window: ComparisonWindow): string {
  if (window.mode === 'daily') {
    const day = new Date(window.end.getTime() - 1);
    return `Closed UTC day ${dayLabel(day)} against the day before. The median is the previous 7 closed days.`;
  }
  const hours = window.duration / HOUR_MS;
  return (
    `00:00 to ${clock(window.end)} UTC today (${hours}h) against the same hours yesterday. ` +
    `The median is the same ${hours}h over the previous 7 days. ` +
    'The day closes at midnight UTC with its own compare.'
  );
}

const percentLabel = (anomaly: BusinessMetricAnomaly) => {
  if (anomaly.percent === null) return anomaly.direction === 'increase' ? 'up from zero' : 'down to zero';
  return `${anomaly.direction === 'increase' ? 'up' : 'down'} ${Math.abs(anomaly.percent).toFixed(1)}%`;
};

const tail = (id: string) => id.slice(-4);

function contributorLink(row: MetricContributor, appUrl: string | undefined): string {
  const [kind, ...rest] = row.label.split(':');
  const id = rest.join(':');
  const origin = appUrl?.replace(/\/+$/, '');
  if (kind === 'model') return escapeMrkdwn(modelDisplayName(id));
  if (kind === 'user' && id) {
    const label = `user \u2026${escapeMrkdwn(tail(id))}`;
    return origin ? `<${origin}/admin/users/${encodeURIComponent(id)}|${label}>` : label;
  }
  if (kind === 'org' && id) {
    const label = `org \u2026${escapeMrkdwn(tail(id))}`;
    const search = new URLSearchParams({ tab: 'organizations', orgId: id });
    return origin ? `<${origin}/admin?${search}|${label}>` : label;
  }
  return escapeMrkdwn(row.label);
}

/**
 * "Top movers: Claude Opus 5.5 -2,958 credits, user ...dc47 -524 credits and 3 more". A list where
 * every row moved by exactly one (signups, active users) is the accounts themselves: on a rise
 * the first few are linked so a suspected farm account is one click away; on a fall the line is
 * omitted, since yesterday's accounts are not actionable.
 */
export function describeContributors(
  anomaly: BusinessMetricAnomaly,
  metric: MetricDescription,
  appUrl: string | undefined
): string | undefined {
  const rows = anomaly.contributors;
  if (rows.length === 0) return undefined;
  const shown = rows.slice(0, MAX_CONTRIBUTORS);
  const more = rows.length - shown.length;
  const rest = more > 0 ? ` and ${more} more` : '';
  if (rows.every(row => /^(user|org):/.test(row.label) && Math.abs(row.value) === 1)) {
    if (anomaly.direction === 'decrease') return undefined;
    return `Accounts: ${shown.map(row => contributorLink(row, appUrl)).join(', ')}${rest}`;
  }
  const movers = shown.map(row => `${contributorLink(row, appUrl)} ${formatMetricDelta(row.value, metric)}`);
  return `Top movers: ${movers.join(', ')}${rest}`;
}

function anomalySection(anomaly: BusinessMetricAnomaly, appUrl: string | undefined): string {
  const metric = describeMetric(anomaly.metricName);
  const signal = metricSignal(anomaly.metricName, anomaly.direction);
  const median =
    anomaly.median === null ? 'median warming up' : `7-day median ${formatMetricValue(anomaly.median, metric)}`;
  const lines = [
    `${GLYPH[signal]} *${escapeMrkdwn(metric.label)}* ${percentLabel(anomaly)}`,
    `Now *${formatMetricValue(anomaly.current, metric)}*, previous ${formatMetricValue(anomaly.previous, metric)}, ${median}`,
    `_${escapeMrkdwn(metricMeaning(anomaly.metricName, anomaly.direction))}_`,
  ];
  const movers = describeContributors(anomaly, metric, appUrl);
  if (movers) lines.push(movers);
  return lines.join('\n');
}

function buttons(anomalies: BusinessMetricAnomaly[], appUrl: string | undefined) {
  const origin = appUrl?.replace(/\/+$/, '');
  if (!origin) return [];
  const list = [{ label: 'Open analytics', url: `${origin}/admin?tab=analytics` }];
  const rising = (family: string) =>
    anomalies.some(anomaly => anomaly.direction === 'increase' && anomaly.metricName.split(':')[0] === family);
  if (rising('verifiedSignups') || rising('activeUsers'))
    list.push({ label: 'Signup activity', url: `${origin}/admin?tab=users&recentSignups=hour` });
  if (rising('credits') || rising('spendUsd'))
    list.push({ label: 'Credit analytics', url: `${origin}/admin?tab=credit-analytics` });
  return list;
}

export function formatBusinessMetricSlackMessage(
  window: ComparisonWindow,
  anomalies: BusinessMetricAnomaly[],
  options: BusinessMetricMessageOptions = {}
): BusinessMetricSlackMessage {
  const count = anomalies.length;
  const title = `Business metrics, ${describeWindow(window)}: ${count} ${count === 1 ? 'anomaly' : 'anomalies'}`;
  const signals = anomalies.map(anomaly => metricSignal(anomaly.metricName, anomaly.direction));
  const worst = signals.sort((a, b) => SIGNAL_RANK[a] - SIGNAL_RANK[b])[0] ?? 'growth';
  const summary = anomalies
    .map(anomaly => `${escapeMrkdwn(describeMetric(anomaly.metricName).label)} ${percentLabel(anomaly)}`)
    .join(', ');

  const body: unknown[] = [
    { type: 'context', elements: [{ type: 'mrkdwn', text: escapeMrkdwn(explainWindow(window)) }] },
    ...anomalies.slice(0, MAX_SECTIONS).map(anomaly => ({
      type: 'section',
      text: { type: 'mrkdwn', text: anomalySection(anomaly, options.appUrl) },
    })),
  ];
  if (anomalies.length > MAX_SECTIONS) {
    body.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `${anomalies.length - MAX_SECTIONS} more anomalies not shown.` },
    });
  }
  const actions = buttons(anomalies, options.appUrl);
  if (actions.length > 0) {
    body.push({
      type: 'actions',
      elements: actions.map((button, index) => ({
        type: 'button',
        text: { type: 'plain_text', text: button.label, emoji: true },
        url: button.url,
        action_id: `business-metric-link-${index}`,
      })),
    });
  }
  const stamp = `${clock(window.end)} UTC, ${dayLabel(window.end)}`;
  const context = ['category business', options.stage ? escapeMrkdwn(options.stage) : undefined, stamp].filter(
    Boolean
  ) as string[];
  body.push({ type: 'context', elements: [{ type: 'mrkdwn', text: context.join(SEPARATOR) }] });

  return {
    text: `${title}: ${summary}`,
    blocks: [{ type: 'header', text: { type: 'plain_text', text: `:bar_chart: ${title}`.slice(0, 150), emoji: true } }],
    attachments: [{ color: COLOR[worst], blocks: body }],
  };
}

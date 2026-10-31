/**
 * Posts one Security alert per actor whose probing of the API scores past the admin threshold in
 * the window (scoring: ./apiProbeScoring.ts). Settings: probeDetector* in
 * b4m-core/common/src/schemas/settings.ts. Schedule: rate(5 minutes), production only
 * (infra/cron.ts apiProbeDetector). Hosted only: it reads the server function's CloudWatch log group,
 * which a self-host deployment does not have.
 */

import { createHash } from 'node:crypto';
import { escapeSlackText, toAbsoluteUrl } from '@bike4mind/common';
import { adminSettingsRepository, cacheRepository, connectDB, userRepository } from '@bike4mind/database';
import type { UserLinkState } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { postMessageToSlackWithOutcome } from '@bike4mind/server-utils/integrations/slack/slack';
import { Config } from '@bike4mind/server-utils/utils/config';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { Resource } from 'sst';
import { z } from 'zod';

import { appUrlFromEnv } from '../events/alarmSlackMessage';
import { formatAccountAge } from '../events/youngAccountSpendDetail';
import { runLogsInsightsQuery } from '../utils/logsInsights';
import {
  BREADTH_GATE_PATHS,
  PROBE_QUERY,
  QUERY_ROW_LIMIT,
  actorsOverThreshold,
  groupProbeActors,
  parseProbeRows,
  type ProbeActor,
  type ProbeSignal,
} from './apiProbeScoring';

/** Set by infra/cron.ts; the Next.js server function's log group. */
export const API_SERVER_LOG_GROUP_ENV = 'API_SERVER_LOG_GROUP';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEDUPE_KEY_PREFIX = 'api-probe-alert';
/** Bounds one run's Slack posts; anything past it is logged and reported on the next run. */
const MAX_ALERTS_PER_RUN = 5;
const LISTED_IDENTIFIERS = 10;
const LISTED_PATHS = 6;

const POLICY_SETTING_NAMES = [
  'probeDetectorEnabled',
  'probeDetectorScoreThreshold',
  'probeDetectorWindowMinutes',
  'probeDetectorDedupeHours',
] as const;

export type ProbeDetectorPolicy = {
  enabled: boolean;
  threshold: number;
  windowMs: number;
  dedupeMs: number;
};

const SIGNAL_LABELS: Record<ProbeSignal, string> = {
  refusedFetch: 'refused fetch targets',
  webhookSignature: 'failed Stripe webhook signatures',
  invalidId: 'invalid-id lookups',
  denied: '401/403 denials',
  notFound: '404s',
};

export async function loadProbeDetectorPolicy(): Promise<ProbeDetectorPolicy> {
  // Fresh read so the kill switch applies on the next run, not after a cache TTL.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { skipCache: true, names: [...POLICY_SETTING_NAMES] }
  );
  return {
    enabled: getSettingsValue('probeDetectorEnabled', settings, true),
    threshold: getSettingsValue('probeDetectorScoreThreshold', settings, 25),
    windowMs: getSettingsValue('probeDetectorWindowMinutes', settings, 15) * MINUTE_MS,
    dedupeMs: getSettingsValue('probeDetectorDedupeHours', settings, 6) * HOUR_MS,
  };
}

const hashIp = (ip: string) => createHash('sha256').update(ip).digest('hex').slice(0, 32);

/** One key per identifier, so an actor is recognised again from either its IP or its account. IPs are hashed so the Cache row holds no raw address. */
export function probeDedupeKeys(actor: Pick<ProbeActor, 'ips' | 'userIds'>): string[] {
  return [
    ...actor.ips.map(ip => `${DEDUPE_KEY_PREFIX}:ip:${hashIp(ip)}`),
    ...actor.userIds.map(userId => `${DEDUPE_KEY_PREFIX}:user:${userId}`),
  ];
}

/**
 * Claims every identifier of the actor. The actor is new, and pages, when at least one identifier
 * was not already claimed inside the dedupe window: the same actor stays quiet, but a known
 * account seen from a new IP (or a known IP driving a new account) pages again.
 */
export async function claimProbeAlert(actor: ProbeActor, dedupeMs: number): Promise<string[]> {
  const claimed: string[] = [];
  for (const key of probeDedupeKeys(actor)) {
    const result = await cacheRepository.claimDedup(key, { score: actor.score }, dedupeMs);
    if (result.claimed) claimed.push(key);
  }
  return claimed;
}

function adminUserRef(userId: string, appUrl: string | undefined): string {
  const id = `\`${escapeSlackText(userId)}\``;
  if (!appUrl) return id;
  const link = toAbsoluteUrl(appUrl, `/admin/users/${encodeURIComponent(userId)}`);
  return `${id} - <${escapeSlackText(link)}|Open in admin>`;
}

function listWithOverflow(items: string[], limit: number): string[] {
  const shown = items.slice(0, limit);
  return items.length > limit ? [...shown, `(+${items.length - limit} more)`] : shown;
}

function describeUser(userId: string, users: Map<string, UserLinkState>, at: Date, appUrl: string | undefined) {
  const user = users.get(userId);
  if (!user) return `${adminUserRef(userId, appUrl)} (no such account)`;
  const age = formatAccountAge(user.createdAt ?? undefined, at);
  const state = user.isBanned ? ', already banned' : '';
  return `${adminUserRef(userId, appUrl)} (${age}${state})`;
}

export function formatProbeAlert(input: {
  actor: ProbeActor;
  users: Map<string, UserLinkState>;
  threshold: number;
  window: { start: Date; end: Date };
  stage: string;
  appUrl: string | undefined;
}): string {
  const { actor, users, threshold, window, stage, appUrl } = input;
  const signalLines = (Object.keys(SIGNAL_LABELS) as ProbeSignal[])
    .filter(signal => actor.counts[signal] > 0)
    .map(signal => `- ${actor.counts[signal]} ${SIGNAL_LABELS[signal]}`);
  const userLines =
    actor.userIds.length > 0
      ? listWithOverflow(
          actor.userIds.map(id => describeUser(id, users, window.end, appUrl)),
          LISTED_IDENTIFIERS
        ).map(line => `- ${line}`)
      : ['- none signed in'];

  const lines = [
    `:mag: *Probable API probing (${escapeSlackText(stage)})*`,
    `Window: ${window.start.toISOString()} to ${window.end.toISOString()}`,
    `Score ${actor.score} (threshold ${threshold}), ~${actor.distinctPaths} distinct paths ` +
      `(401/403/404 count from ${BREADTH_GATE_PATHS}+ paths per IP and account)`,
    '*Signals*',
    ...signalLines,
    '*Accounts*',
    ...userLines,
    `*IPs*: ${listWithOverflow(
      actor.ips.map(ip => `\`${escapeSlackText(ip)}\``),
      LISTED_IDENTIFIERS
    ).join(', ')}`,
    `*Sample paths*: ${listWithOverflow(
      actor.samplePaths.map(path => `\`${escapeSlackText(path)}\``),
      LISTED_PATHS
    ).join(', ')}`,
  ];
  if (actor.userIds.length > 0) {
    lines.push('To contain: Admin > Users, select the accounts above, then bulk Contain (reversible with Undo).');
  }
  return lines.join('\n');
}

const scheduledEventSchema = z.object({ time: z.iso.datetime() });

export type ProbeDetectorResult =
  | { status: 'skipped'; reason: string }
  | { status: 'ok'; actors: number; alerted: number; suppressed: number; deferred: number; truncated: boolean };

export async function handler(event: unknown): Promise<ProbeDetectorResult> {
  const logger = new Logger().withMetadata({ cron: 'apiProbeDetector', stage: Resource.App.stage });

  if (Resource.App.stage !== 'production') {
    return { status: 'skipped', reason: 'non-production environment' };
  }
  const logGroup = process.env[API_SERVER_LOG_GROUP_ENV]?.trim();
  if (!logGroup) throw new Error(`${API_SERVER_LOG_GROUP_ENV} is not set`);

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
  const policy = await loadProbeDetectorPolicy();
  if (!policy.enabled) return { status: 'skipped', reason: 'disabled in admin settings' };

  // Event time stays fixed across delayed delivery and retries, so a retry rescans the same window.
  const end = new Date(scheduledEventSchema.parse(event).time);
  const window = { start: new Date(end.getTime() - policy.windowMs), end };

  const rows = await runLogsInsightsQuery({ logGroup, window, queryString: PROBE_QUERY, limit: QUERY_ROW_LIMIT });
  const truncated = rows.length >= QUERY_ROW_LIMIT;
  const actors = actorsOverThreshold(groupProbeActors(parseProbeRows(rows)), policy.threshold);
  logger.log('api-probe-scan', {
    windowStart: window.start.toISOString(),
    windowEnd: end.toISOString(),
    rows: rows.length,
    truncated,
    actors: actors.map(actor => ({ score: actor.score, ips: actor.ips.length, users: actor.userIds.length })),
  });

  const appUrl = appUrlFromEnv();
  let alerted = 0;
  let suppressed = 0;
  let deferred = 0;
  for (const actor of actors) {
    if (alerted >= MAX_ALERTS_PER_RUN) {
      deferred++;
      continue;
    }
    const claimed = await claimProbeAlert(actor, policy.dedupeMs);
    if (claimed.length === 0) {
      suppressed++;
      continue;
    }
    const users = new Map((await userRepository.findLinkStatesByIds(actor.userIds)).map(user => [user.id, user]));
    const outcome = await postMessageToSlackWithOutcome(
      formatProbeAlert({ actor, users, threshold: policy.threshold, window, stage: Resource.App.stage, appUrl }),
      'SlackSecurityAlertsWebhookUrl',
      { timeoutMs: 5_000 }
    );
    // A failed post releases this run's claims so the next run retries. 'unconfigured' keeps them:
    // security alerts are switched off, and the Slack module already warned about that.
    if (outcome === 'failed') {
      await Promise.all(claimed.map(key => cacheRepository.deleteByKey(key)));
      logger.error('api-probe-alert-not-delivered', { score: actor.score });
      continue;
    }
    alerted++;
  }
  if (deferred > 0) logger.error('api-probe-alerts-deferred', { deferred });

  return { status: 'ok', actors: actors.length, alerted, suppressed, deferred, truncated };
}

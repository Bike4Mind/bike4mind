import type { DeviceLinkRow, RecordShadowDetectionInput } from '@bike4mind/database';
import { cacheRepository, loadDeviceLinkAccounts, shadowDetectionRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { userService } from '@bike4mind/services';
import { assessShadowDetection } from '@server/security/abuseAssessment/abuseAssessment';
import { linkedAccountGroupEvidence } from '@server/security/abuseAssessment/linkedAccountEvidence';
import {
  evaluateDeviceLinks,
  liveDeviceLinkReaders,
  type DeviceLinkConfig,
  type DeviceLinkReaders,
} from './deviceLinkEvaluation';
import { applyAutoContainment, liveAutoContainmentDeps, loadAutoContainmentConfig } from './executor';

/**
 * The ban-evasion device rule: a new account used from the same uncommon device (screen size, pixel
 * ratio, user agent) as a banned account, with at least one more corroborating signal (engine:
 * b4m-core/services/src/userService/deviceLinkage.ts), is recorded as a `deviceLinkedToBlocked`
 * detection and assessed at once; the judgment then goes to automated containment. It complements
 * the IP strong-link rule (strongLink.ts), which a VPN that rotates the exit IP slips past.
 *
 * Runs at signup (queueHandlers/riskEvidence.ts; an email-code signup stores the device before the
 * signup message is sent) and hourly over the last RECENT_SIGNUP_HOURS of signups
 * (cron/accountCampaignSweep.ts), which catches a device first seen at a later sign-in.
 */

const HOUR_MS = 60 * 60 * 1000;
export const DEVICE_LINKED_TO_BLOCKED_POLICY_VERSION = 1;
const DEDUPE_KEY_PREFIX = 'shadow-detection:device-linked-to-blocked';
const DEDUPE_TTL_MS = 31 * 24 * HOUR_MS;
/** How far back the hourly pass looks for new accounts. */
export const RECENT_SIGNUP_HOURS = 72;
const RECENT_SIGNUP_LIMIT = 2_000;

export type { DeviceLinkConfig };

export type DeviceLinkResult =
  | {
      status: 'skipped';
      reason:
        | 'disabled'
        | 'not_found'
        | 'already_recorded'
        | Extract<userService.BanEvasionResult, { linked: false }>['reason'];
    }
  | { status: 'recorded'; detectionId: string; assessed: boolean; contained: boolean };

export type DeviceLinkDeps = DeviceLinkReaders & {
  loadConfig: () => Promise<DeviceLinkConfig | null>;
  loadAccounts: (userIds: string[]) => Promise<DeviceLinkRow[]>;
  claimOnce: (userId: string) => Promise<boolean>;
  releaseClaim: (userId: string) => Promise<unknown>;
  recordDetection: (input: RecordShadowDetectionInput) => Promise<string>;
  assessAndContain: (detectionId: string) => Promise<{ assessed: boolean; contained: boolean }>;
};

const AXIS_LABELS: Record<userService.DeviceLinkAxis, string> = {
  fingerprint: 'the same TLS fingerprint',
  network: 'the same signup network',
  timing: 'signups close in time',
};

export function buildDeviceLinkDetection(
  userId: string,
  link: Extract<userService.BanEvasionResult, { linked: true }>,
  config: DeviceLinkConfig,
  detectedAt: Date
): RecordShadowDetectionInput {
  const [best] = link.matches;
  const count = link.matches.length;
  const has = (axis: userService.DeviceLinkAxis) => (best.corroboration.includes(axis) ? 1 : 0);
  const hours = best.hoursApart;
  return {
    detector: 'deviceLinkedToBlocked',
    policyVersion: DEVICE_LINKED_TO_BLOCKED_POLICY_VERSION,
    wouldAction: 'contain',
    summary:
      `Used the same device as ${count} banned account${count === 1 ? '' : 's'}` +
      (hours === null ? '' : `, the closest ${hours} hour${hours === 1 ? '' : 's'} apart`) +
      `, with ${best.corroboration.map(axis => AXIS_LABELS[axis]).join(' and ')}`,
    userIds: [userId],
    network: null,
    signals: [
      { key: 'bannedDeviceLinks', label: 'Banned accounts on the same device', observed: count, threshold: 1 },
      {
        key: 'deviceNetworkSpread',
        label: 'Networks the device was seen on in 30 days (common at or above the threshold)',
        observed: link.deviceNetworkSpread,
        threshold: config.commonNetworks,
      },
      {
        key: 'corroboratingSignals',
        label: 'Signals besides the device that agree',
        observed: best.corroboration.length,
        threshold: userService.DEFAULT_DEVICE_LINK_POLICY.minCorroboratingAxes,
      },
      { key: 'sameFingerprint', label: 'Same uncommon TLS fingerprint', observed: has('fingerprint'), threshold: 1 },
      { key: 'sameSignupNetwork', label: 'Same signup network', observed: has('network'), threshold: 1 },
      {
        key: 'hoursToBannedDeviceLink',
        label: 'Hours between this signup and the closest banned one on the device',
        observed: hours,
        threshold: config.windowHours,
      },
    ],
    windowMinutes: config.windowHours * 60,
    group: null,
    payment: null,
    detectedAt,
  };
}

export function liveDeviceLinkDeps(logger: Logger): DeviceLinkDeps {
  return {
    loadConfig: async () => {
      const config = await loadAutoContainmentConfig();
      return config.mode === 'off' || config.deviceLinkWindowHours === 0
        ? null
        : { windowHours: config.deviceLinkWindowHours, commonNetworks: config.deviceLinkCommonNetworks };
    },
    ...liveDeviceLinkReaders,
    loadAccounts: ids => loadDeviceLinkAccounts(ids),
    claimOnce: async userId =>
      (await cacheRepository.claimDedup(`${DEDUPE_KEY_PREFIX}:${userId}`, { userId }, DEDUPE_TTL_MS)).claimed,
    releaseClaim: userId => cacheRepository.deleteByKey(`${DEDUPE_KEY_PREFIX}:${userId}`),
    recordDetection: input => shadowDetectionRepository.record(input),
    assessAndContain: async detectionId => {
      const outcome = await assessShadowDetection({
        detectionId,
        trigger: 'strong_link',
        requestedBy: null,
        logger,
        deps: { groupEvidence: linkedAccountGroupEvidence },
      });
      if (outcome.status !== 'assessed') return { assessed: false, contained: false };
      const run = await applyAutoContainment(outcome.item, liveAutoContainmentDeps(logger));
      const contained =
        run.status === 'decided' && (run.decision.outcome === 'contained' || run.decision.outcome === 'would_contain');
      return { assessed: true, contained };
    },
  };
}

async function recordLink(
  userId: string,
  link: Extract<userService.BanEvasionResult, { linked: true }>,
  config: DeviceLinkConfig,
  deps: DeviceLinkDeps
): Promise<DeviceLinkResult> {
  if (!(await deps.claimOnce(userId))) return { status: 'skipped', reason: 'already_recorded' };
  let detectionId: string;
  try {
    detectionId = await deps.recordDetection(buildDeviceLinkDetection(userId, link, config, deps.now()));
  } catch (error) {
    await deps.releaseClaim(userId);
    throw error;
  }
  const { assessed, contained } = await deps.assessAndContain(detectionId);
  return { status: 'recorded', detectionId, assessed, contained };
}

/** Applies the rule to one account. Throws only on a database failure. */
export async function checkDeviceLink(userId: string, deps: DeviceLinkDeps): Promise<DeviceLinkResult> {
  const config = await deps.loadConfig();
  if (!config) return { status: 'skipped', reason: 'disabled' };
  const rows = await deps.loadAccounts([userId]);
  if (rows.length === 0) return { status: 'skipped', reason: 'not_found' };
  const result = (await evaluateDeviceLinks(rows, config, deps)).get(userId);
  if (!result) return { status: 'skipped', reason: 'no_device' };
  if (!result.linked) return { status: 'skipped', reason: result.reason };
  return recordLink(userId, result, config, deps);
}

export type DeviceLinkSweepReport = {
  status: 'disabled' | 'done';
  scanned: number;
  scanTruncated: boolean;
  linked: number;
  recorded: number;
  alreadyRecorded: number;
  failed: number;
};

/**
 * The hourly pass over recent signups. One account's failure is counted and the rest still run;
 * a read failure for the whole batch throws.
 */
export async function sweepDeviceLinks(
  deps: DeviceLinkDeps & {
    loadRecent: (input: { since: Date; until: Date; limit: number }) => Promise<{
      rows: DeviceLinkRow[];
      truncated: boolean;
    }>;
    onError?: (userId: string, error: unknown) => void;
  }
): Promise<DeviceLinkSweepReport> {
  const report: DeviceLinkSweepReport = {
    status: 'done',
    scanned: 0,
    scanTruncated: false,
    linked: 0,
    recorded: 0,
    alreadyRecorded: 0,
    failed: 0,
  };
  const config = await deps.loadConfig();
  if (!config) return { ...report, status: 'disabled' };
  const now = deps.now();
  const recent = await deps.loadRecent({
    since: new Date(now.getTime() - RECENT_SIGNUP_HOURS * HOUR_MS),
    until: now,
    limit: RECENT_SIGNUP_LIMIT,
  });
  report.scanned = recent.rows.length;
  report.scanTruncated = recent.truncated;
  const results = await evaluateDeviceLinks(recent.rows, config, deps);
  for (const [userId, result] of results) {
    if (!result.linked) continue;
    report.linked += 1;
    try {
      const outcome = await recordLink(userId, result, config, deps);
      if (outcome.status === 'recorded') report.recorded += 1;
      else report.alreadyRecorded += 1;
    } catch (error) {
      report.failed += 1;
      deps.onError?.(userId, error);
    }
  }
  return report;
}

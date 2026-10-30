import { parseOauthAbuseEscalationMinutes } from '@bike4mind/common';
import {
  adminSettingsRepository,
  authFailLogRepository,
  blockedIPRepository,
  type IBlockedIPDocument,
} from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DEFAULT_SCHEDULE_MINUTES = [10, 60, 1440];

/**
 * Only refusals reached after obtaining a provider profile count toward an automatic IP block.
 * State failures are forgeable without a provider round trip and must not lock out a shared NAT.
 */
export const OAUTH_ABUSE_REASONS = ['registration_closed', 'duplicate_account', 'forbidden_system_user'] as const;

/**
 * Strategies served by the shared `[strategy]` OAuth routes. SAML and Okta have their own callbacks
 * and write some of the same reasons (e.g. `duplicate_account`), so they must not count here.
 */
export const OAUTH_ABUSE_STRATEGIES = ['google', 'facebook', 'github'] as const;

const POLICY_SETTING_NAMES = [
  'oauthAbuseAutoBlockEnabled',
  'oauthAbuseAttemptThreshold',
  'oauthAbuseWindowMinutes',
  'oauthAbuseBlockEscalationMinutes',
  'oauthAbuseLookbackHours',
] as const;

export interface OauthAbusePolicy {
  enabled: boolean;
  threshold: number;
  windowMs: number;
  escalationMs: readonly number[];
  lookbackMs: number;
}

type LatestBlock = Pick<IBlockedIPDocument, 'active' | 'expiresAt' | 'unblockedAt'> &
  Partial<Pick<IBlockedIPDocument, 'source' | 'escalationLevel'>>;

export interface OauthAbuseAutoBlockDeps {
  loadPolicy: () => Promise<OauthAbusePolicy>;
  getIPsWithHighAttempts: (since: Date, minAttempts: number) => Promise<Array<{ ip: string; attempts: number }>>;
  countAttemptsSince: (ip: string, since: Date) => Promise<number>;
  findLatestBlock: (ip: string) => Promise<LatestBlock | null>;
  block: (
    ip: string,
    reason: string,
    options: { durationMs: number; source: 'auto'; escalationLevel: number }
  ) => Promise<{ created: boolean }>;
}

export interface OauthAbuseAutoBlockResult {
  evaluatedSince: Date;
  /** New blocks only; a block() that merely extended an existing row is left out. */
  blocked: Array<{ ip: string; attempts: number; durationMs: number; escalationLevel: number }>;
  failed: string[];
}

/** Positive whole minutes from a CSV; blank or any malformed entry falls back to the default schedule. */
export function parseEscalationMinutes(raw: string): number[] {
  return parseOauthAbuseEscalationMinutes(raw) ?? [...DEFAULT_SCHEDULE_MINUTES];
}

/** Step `level` of the schedule, clamped to the last step. */
export function resolveBlockDurationMs(level: number, scheduleMs: readonly number[]): number {
  return scheduleMs[Math.min(level, scheduleMs.length - 1)];
}

async function loadPolicy(): Promise<OauthAbusePolicy> {
  // Fresh read so an admin change or the kill switch applies on the next run, not after a cache TTL.
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    {
      skipCache: true,
      names: [...POLICY_SETTING_NAMES],
    }
  );
  return {
    enabled: getSettingsValue('oauthAbuseAutoBlockEnabled', settings, true),
    threshold: getSettingsValue('oauthAbuseAttemptThreshold', settings, 20),
    windowMs: getSettingsValue('oauthAbuseWindowMinutes', settings, 10) * MINUTE_MS,
    escalationMs: parseEscalationMinutes(getSettingsValue('oauthAbuseBlockEscalationMinutes', settings, '')).map(
      m => m * MINUTE_MS
    ),
    lookbackMs: getSettingsValue('oauthAbuseLookbackHours', settings, 24) * HOUR_MS,
  };
}

const defaultDeps: OauthAbuseAutoBlockDeps = {
  loadPolicy,
  getIPsWithHighAttempts: (since, min) =>
    authFailLogRepository.getIPsWithHighAttemptsForReasons(since, min, OAUTH_ABUSE_REASONS, OAUTH_ABUSE_STRATEGIES),
  countAttemptsSince: (ip, since) =>
    authFailLogRepository.countForIPAndReasons(ip, since, OAUTH_ABUSE_REASONS, OAUTH_ABUSE_STRATEGIES),
  findLatestBlock: ip => blockedIPRepository.findLatestBlock(ip),
  block: (ip, reason, options) => blockedIPRepository.block(ip, reason, options),
};

/** When the IP's latest block stopped applying: an admin unblock, or its expiry. */
function blockEndedAt(block: { expiresAt: Date; unblockedAt?: Date }): Date {
  return block.unblockedAt && block.unblockedAt < block.expiresAt ? block.unblockedAt : block.expiresAt;
}

/**
 * Escalation step for a new block: one past the previous auto block's step while that block ended
 * inside the lookback, so a persistent attacker stays at the last step. A manual block, an admin
 * unblock or a quiet lookback start over at the first step.
 */
function nextEscalationLevel(latest: LatestBlock | null, lookbackStart: Date, lastLevel: number): number {
  if (latest?.source !== 'auto' || latest.expiresAt < lookbackStart) return 0;
  if (latest.unblockedAt && latest.unblockedAt < latest.expiresAt) return 0;
  return Math.min((latest.escalationLevel ?? 0) + 1, lastLevel);
}

/**
 * Blocks every IP whose OAuth abuse count in the window reaches the threshold, escalating the block
 * duration from the IP's previous auto block (see nextEscalationLevel). Run every minute by the
 * oauthAbuseAutoBlock cron and on demand by the admin evaluate endpoint. A failure on one IP does
 * not stop the rest.
 *
 * Only failures after the IP's previous block ended count, so an admin unblock, or a block that
 * simply expired, is not undone by the rows that caused it. IPs that are blocked right now are skipped.
 *
 * Counts and blocks raw addresses, unlike oauthIpRateLimit which buckets IPv6 by /64 (ipBucket): a
 * client rotating addresses inside its /64 never reaches the threshold here and is capped only by
 * the limiter. Keying on ipBucket would also need checkBlockedIP to match buckets for every caller.
 */
export async function runOauthAbuseAutoBlock(
  options: { now?: Date; deps?: Partial<OauthAbuseAutoBlockDeps> } = {}
): Promise<OauthAbuseAutoBlockResult> {
  const deps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? new Date();
  const policy = await deps.loadPolicy();
  const evaluatedSince = new Date(now.getTime() - policy.windowMs);
  const result: OauthAbuseAutoBlockResult = { evaluatedSince, blocked: [], failed: [] };
  if (!policy.enabled) return result;

  const lookbackStart = new Date(now.getTime() - policy.lookbackMs);
  for (const candidate of await deps.getIPsWithHighAttempts(evaluatedSince, policy.threshold)) {
    const { ip } = candidate;
    let { attempts } = candidate;
    try {
      const latest = await deps.findLatestBlock(ip);
      if (latest?.active && latest.expiresAt > now) continue;
      const endedAt = latest ? blockEndedAt(latest) : undefined;
      if (endedAt && endedAt > evaluatedSince) {
        attempts = await deps.countAttemptsSince(ip, endedAt);
        if (attempts < policy.threshold) continue;
      }

      const escalationLevel = nextEscalationLevel(latest, lookbackStart, policy.escalationMs.length - 1);
      const durationMs = resolveBlockDurationMs(escalationLevel, policy.escalationMs);
      const { created } = await deps.block(
        ip,
        `Auto-blocked: ${attempts} failed sign-ins in ${policy.windowMs / MINUTE_MS} minutes`,
        {
          durationMs,
          source: 'auto',
          escalationLevel,
        }
      );
      if (created) result.blocked.push({ ip, attempts, durationMs, escalationLevel });
    } catch (error) {
      console.warn(`Failed to auto-block IP ${ip}`, error);
      result.failed.push(ip);
    }
  }
  return result;
}

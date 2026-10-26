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
 * AuthFailLog reasons that count as abuse of the shared OAuth flow. Deliberately excludes `internal`
 * and `state_expired` (our own faults and slow users) and every other strategy's rows: a bug on our
 * side must not auto-block an office. Keep in sync with OAUTH_FAILURE_REASONS in
 * apps/client/server/utils/auth/oauthFailureReason.ts.
 */
export const OAUTH_ABUSE_REASONS = [
  'registration_closed',
  'state_invalid',
  'state_missing',
  'duplicate_account',
  'forbidden_system_user',
] as const;

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

export interface OauthAbuseAutoBlockDeps {
  loadPolicy: () => Promise<OauthAbusePolicy>;
  getIPsWithHighAttempts: (since: Date, minAttempts: number) => Promise<Array<{ ip: string; attempts: number }>>;
  countAttemptsSince: (ip: string, since: Date) => Promise<number>;
  findLatestBlock: (ip: string) => Promise<Pick<IBlockedIPDocument, 'active' | 'expiresAt' | 'unblockedAt'> | null>;
  countAutoBlocksEndingSince: (ip: string, since: Date) => Promise<number>;
  block: (
    ip: string,
    reason: string,
    options: { durationMs: number; source: 'auto'; escalationLevel: number }
  ) => Promise<unknown>;
}

export interface OauthAbuseAutoBlockResult {
  evaluatedSince: Date;
  blocked: Array<{ ip: string; attempts: number; durationMs: number; escalationLevel: number }>;
}

/** Positive whole minutes from a CSV; blank or any malformed entry falls back to the default schedule. */
export function parseEscalationMinutes(raw: string): number[] {
  const parts = raw.split(',').map(p => p.trim());
  const minutes = parts.map(p => (/^\d+$/.test(p) ? Number(p) : 0));
  return minutes.length > 0 && minutes.every(m => m > 0) ? minutes : [...DEFAULT_SCHEDULE_MINUTES];
}

/** Step `priorAutoBlocks` of the schedule, clamped to the last step. */
export function resolveBlockDurationMs(priorAutoBlocks: number, scheduleMs: readonly number[]): number {
  return scheduleMs[Math.min(priorAutoBlocks, scheduleMs.length - 1)];
}

async function loadPolicy(): Promise<OauthAbusePolicy> {
  // Fresh read so an admin change or the kill switch applies on the next run, not after a cache TTL.
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository }, {
    skipCache: true,
    names: [...POLICY_SETTING_NAMES],
  });
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
    authFailLogRepository.getIPsWithHighAttemptsForReasons(since, min, OAUTH_ABUSE_REASONS),
  countAttemptsSince: (ip, since) => authFailLogRepository.countForIPAndReasons(ip, since, OAUTH_ABUSE_REASONS),
  findLatestBlock: ip => blockedIPRepository.findLatestBlock(ip),
  countAutoBlocksEndingSince: (ip, since) => blockedIPRepository.countAutoBlocksEndingSince(ip, since),
  block: (ip, reason, options) => blockedIPRepository.block(ip, reason, options),
};

/** When the IP's latest block stopped applying: an admin unblock, or its expiry. */
function blockEndedAt(block: { expiresAt: Date; unblockedAt?: Date }): Date {
  return block.unblockedAt && block.unblockedAt < block.expiresAt ? block.unblockedAt : block.expiresAt;
}

/**
 * Blocks every IP whose OAuth abuse count in the window reaches the threshold, escalating the block
 * duration with each earlier auto block of that IP inside the lookback. Run every minute by the
 * oauthAbuseAutoBlock cron and on demand by the admin evaluate endpoint. A failure on one IP does
 * not stop the rest.
 *
 * Only failures after the IP's previous block ended count, so an admin unblock, or a block that
 * simply expired, is not undone by the rows that caused it. IPs that are blocked right now are skipped.
 */
export async function runOauthAbuseAutoBlock(
  options: { now?: Date; deps?: Partial<OauthAbuseAutoBlockDeps> } = {}
): Promise<OauthAbuseAutoBlockResult> {
  const deps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? new Date();
  const policy = await deps.loadPolicy();
  const evaluatedSince = new Date(now.getTime() - policy.windowMs);
  const result: OauthAbuseAutoBlockResult = { evaluatedSince, blocked: [] };
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

      const escalationLevel = Math.min(
        await deps.countAutoBlocksEndingSince(ip, lookbackStart),
        policy.escalationMs.length - 1
      );
      const durationMs = resolveBlockDurationMs(escalationLevel, policy.escalationMs);
      await deps.block(ip, `Auto-blocked: ${attempts} failed sign-ins in ${policy.windowMs / MINUTE_MS} minutes`, {
        durationMs,
        source: 'auto',
        escalationLevel,
      });
      result.blocked.push({ ip, attempts, durationMs, escalationLevel });
    } catch (error) {
      console.warn(`Failed to auto-block IP ${ip}`, error);
    }
  }
  return result;
}

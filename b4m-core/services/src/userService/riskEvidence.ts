import {
  RISK_EVIDENCE_SCAN_LIMIT,
  RISK_EVIDENCE_USAGE_SCAN_LIMIT,
  RISK_EVIDENCE_VERSION,
  RISK_EVIDENCE_WINDOW_DAYS,
  riskEvidenceSummarySchema,
  type IUsageEventRepository,
  type IUser,
  type IUserApiKeyRepository,
  type IUserRepository,
  type RiskEvidenceFact,
  type RiskEvidenceFactName,
  type RiskEvidenceFacts,
  type RiskEvidenceRefreshMessage,
  type RiskEvidenceSummary,
  type RiskEvidenceTrigger,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** How long a queued refresh waits, so a burst of activity collapses into one refresh (seconds). */
export const RISK_EVIDENCE_DEBOUNCE_SECONDS = 60;

/** A refresh pending longer than this lost its message (or exhausted its retries) and may be requeued. */
export const RISK_EVIDENCE_STALE_CLAIM_MS = 15 * MINUTE_MS;

type Provenance = RiskEvidenceFact['provenance'];

/** Read-only sources, all server-written. Structural so the auth log repositories need no shared interface. */
export interface RiskEvidenceSources {
  authEvents: {
    findByUser: (
      userId: string,
      limit: number
    ) => Promise<{ type: string; createdAt: Date; ip?: string | null; asn?: number | null }[]>;
  };
  authAuditLogs: {
    findByUser: (userId: string, limit: number) => Promise<{ event: string; createdAt: Date }[]>;
  };
  userApiKeys: Pick<IUserApiKeyRepository, 'findFirstCreatedAtByUserId' | 'countCreatedByUserIds'>;
  usageEvents: Pick<IUsageEventRepository, 'activitySummaryByUser'>;
  agentExecutions: { countActiveByUserId: (userId: string) => Promise<number> };
}

type BuildableUser = Pick<IUser, 'id' | 'signupMeta'> & { createdAt: Date };

const observed = <K extends RiskEvidenceFactName>(
  provenance: Provenance,
  value: Extract<RiskEvidenceFacts[K], { status: 'observed' }>['value'],
  extra: { sampleCount: number; latestAt: Date | null; truncated?: boolean }
) =>
  ({
    status: 'observed',
    provenance,
    value,
    sampleCount: extra.sampleCount,
    latestAt: extra.latestAt,
    truncated: extra.truncated ?? false,
  }) as RiskEvidenceFacts[K];

const missing = <K extends RiskEvidenceFactName>(provenance: Provenance, reason: 'not_captured' | 'no_activity') =>
  ({ status: 'missing', provenance, reason }) as RiskEvidenceFacts[K];

/** Run one collector; a read that throws becomes a `failed` fact instead of failing the whole summary. */
async function collect<K extends RiskEvidenceFactName>(
  provenance: Provenance,
  read: () => Promise<RiskEvidenceFacts[K]> | RiskEvidenceFacts[K]
): Promise<RiskEvidenceFacts[K]> {
  try {
    return await read();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', provenance, error: message.slice(0, 200) } as RiskEvidenceFacts[K];
  }
}

const newest = (rows: { createdAt: Date }[]) =>
  rows.reduce<Date | null>((latest, row) => (!latest || row.createdAt > latest ? row.createdAt : latest), null);

/** Rows of a newest-first scan that fall in the window, and whether the scan cut the window short. */
function inWindow<T extends { createdAt: Date }>(rows: T[], from: Date) {
  const kept = rows.filter(row => row.createdAt >= from);
  return { rows: kept, truncated: rows.length >= RISK_EVIDENCE_SCAN_LIMIT && kept.length === rows.length };
}

function signupFacts(user: BuildableUser) {
  const meta = user.signupMeta;
  if (!meta) {
    return {
      signupNetwork: missing<'signupNetwork'>('signup_request', 'not_captured'),
      edgeFingerprint: missing<'edgeFingerprint'>('signup_request', 'not_captured'),
      wafSignals: missing<'wafSignals'>('signup_request', 'not_captured'),
    };
  }
  const capture = { sampleCount: 1, latestAt: new Date(meta.capturedAt) };
  return {
    signupNetwork: observed<'signupNetwork'>(
      'signup_request',
      {
        isDatacenter: meta.isDatacenter,
        asnKnown: meta.asn !== null,
        challengeVerified: meta.challengeVerified === true,
      },
      capture
    ),
    // Presence only: the fingerprint itself stays in signupMeta.
    edgeFingerprint: meta.ja4
      ? observed<'edgeFingerprint'>('signup_request', { ja4Present: true }, capture)
      : missing<'edgeFingerprint'>('signup_request', 'not_captured'),
    // Null means WAF label forwarding was off for that request: unknown, not clean.
    wafSignals:
      typeof meta.wafAnonIp === 'boolean' && typeof meta.wafBotSignal === 'boolean'
        ? observed<'wafSignals'>('signup_request', { anonIp: meta.wafAnonIp, botSignal: meta.wafBotSignal }, capture)
        : missing<'wafSignals'>('signup_request', 'not_captured'),
  };
}

const SENSITIVE_AUDIT_EVENTS = {
  step_up_failed: 'stepUpFailed',
  step_up_success: 'stepUpSucceeded',
  email_change_failed: 'emailChangeFailed',
  mfa_disabled: 'mfaDisabled',
  session_reuse_revoked: 'sessionReuseRevoked',
} as const;

/**
 * Summarize what the server recorded about a user over the trailing window. Recomputed from the
 * source records every time, never accumulated, so a replayed or reordered trigger cannot double
 * count. Each source is read on its own; one failing read marks only its fact `failed`.
 */
export async function buildRiskEvidence(
  user: BuildableUser,
  trigger: RiskEvidenceTrigger,
  { sources, now }: { sources: RiskEvidenceSources; now: Date }
): Promise<RiskEvidenceSummary> {
  const signedUpAt = new Date(user.createdAt);
  const from = new Date(Math.max(signedUpAt.getTime(), now.getTime() - RISK_EVIDENCE_WINDOW_DAYS * DAY_MS));

  const [authActivity, apiKeys, usage, concurrency, sensitiveActions] = await Promise.all([
    collect<'authActivity'>('auth_events', async () => {
      const scan = inWindow(await sources.authEvents.findByUser(user.id, RISK_EVIDENCE_SCAN_LIMIT), from);
      if (scan.rows.length === 0) return missing<'authActivity'>('auth_events', 'no_activity');
      const distinct = (pick: (row: (typeof scan.rows)[number]) => unknown) =>
        new Set(scan.rows.map(pick).filter(value => value !== null && value !== undefined)).size;
      return observed<'authActivity'>(
        'auth_events',
        {
          logins: scan.rows.filter(row => row.type === 'login').length,
          signups: scan.rows.filter(row => row.type === 'signup').length,
          distinctIps: distinct(row => row.ip),
          distinctNetworks: distinct(row => row.asn),
        },
        { sampleCount: scan.rows.length, latestAt: newest(scan.rows), truncated: scan.truncated }
      );
    }),
    collect<'apiKeys'>('api_key_records', async () => {
      const [firstKeyAt, created] = await Promise.all([
        sources.userApiKeys.findFirstCreatedAtByUserId(user.id),
        sources.userApiKeys.countCreatedByUserIds([user.id]),
      ]);
      const count = created[user.id] ?? 0;
      return observed<'apiKeys'>(
        'api_key_records',
        {
          created: count,
          minutesToFirstKey: firstKeyAt ? Math.max(0, (firstKeyAt.getTime() - signedUpAt.getTime()) / MINUTE_MS) : null,
        },
        { sampleCount: count, latestAt: null }
      );
    }),
    collect<'usage'>('usage_ledger', async () => {
      const activity = await sources.usageEvents.activitySummaryByUser(
        user.id,
        from,
        now,
        RISK_EVIDENCE_USAGE_SCAN_LIMIT
      );
      if (activity.events === 0) return missing<'usage'>('usage_ledger', 'no_activity');
      return observed<'usage'>(
        'usage_ledger',
        {
          events: activity.events,
          completed: activity.completed,
          failed: activity.failed,
          creditsSpent: activity.credits,
        },
        {
          sampleCount: activity.events,
          latestAt: activity.latestAt,
          truncated: activity.events >= RISK_EVIDENCE_USAGE_SCAN_LIMIT,
        }
      );
    }),
    collect<'concurrency'>('execution_state', async () =>
      // A point sample at refresh time: no store keeps a history of concurrent runs.
      observed<'concurrency'>(
        'execution_state',
        { activeAgentExecutions: await sources.agentExecutions.countActiveByUserId(user.id) },
        { sampleCount: 1, latestAt: null }
      )
    ),
    collect<'sensitiveActions'>('auth_audit_log', async () => {
      const scan = inWindow(await sources.authAuditLogs.findByUser(user.id, RISK_EVIDENCE_SCAN_LIMIT), from);
      const rows = scan.rows.filter(row => Object.hasOwn(SENSITIVE_AUDIT_EVENTS, row.event));
      if (rows.length === 0) return missing<'sensitiveActions'>('auth_audit_log', 'no_activity');
      const counts = {
        stepUpFailed: 0,
        stepUpSucceeded: 0,
        emailChangeFailed: 0,
        mfaDisabled: 0,
        sessionReuseRevoked: 0,
      };
      for (const row of rows) counts[SENSITIVE_AUDIT_EVENTS[row.event as keyof typeof SENSITIVE_AUDIT_EVENTS]] += 1;
      return observed<'sensitiveActions'>('auth_audit_log', counts, {
        sampleCount: rows.length,
        latestAt: newest(rows),
        truncated: scan.truncated,
      });
    }),
  ]);

  // parse, not a cast: a collector bug must fail here, before anything is stored.
  return riskEvidenceSummarySchema.parse({
    version: RISK_EVIDENCE_VERSION,
    computedAt: now,
    window: { from, to: now },
    trigger,
    facts: { ...signupFacts(user), authActivity, apiKeys, usage, concurrency, sensitiveActions },
  });
}

export type RefreshRiskEvidenceOutcome =
  | { status: 'stored'; summary: RiskEvidenceSummary }
  | { status: 'superseded'; summary: RiskEvidenceSummary }
  | { status: 'no_user' };

export interface RefreshRiskEvidenceAdapters {
  db: {
    users: Pick<
      IUserRepository,
      'findById' | 'releaseRiskEvidenceRefresh' | 'setRiskEvidenceSummary' | 'recordRiskEvidenceFailure'
    >;
  } & RiskEvidenceSources;
  now?: () => Date;
  /** When the refresh was requested: the pendingSince of the claim this refresh releases. */
  requestedAt: Date;
}

/**
 * Rebuild and store a user's evidence summary. Releases only the claim stamped requestedAt, so a newer request's claim survives. Shadow-only by construction: it writes riskEvidence
 * and nothing else, so it can never move riskScore.reviewState (which holds AI access when pending).
 * Throws on failure after recording it on the user, so the queue retries a bounded number of times.
 */
export async function refreshRiskEvidence(
  userId: string,
  trigger: RiskEvidenceTrigger,
  { db, now = () => new Date(), requestedAt }: RefreshRiskEvidenceAdapters
): Promise<RefreshRiskEvidenceOutcome> {
  try {
    // Release before reading: activity that lands mid-refresh then queues one more refresh
    // instead of being folded into a claim this refresh is about to drop.
    await db.users.releaseRiskEvidenceRefresh(userId, requestedAt);
    const user = await db.users.findById(userId);
    if (!user) return { status: 'no_user' };
    const summary = await buildRiskEvidence(user, trigger, { sources: db, now: now() });
    const stored = await db.users.setRiskEvidenceSummary(user.id, summary);
    return { status: stored ? 'stored' : 'superseded', summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.users.recordRiskEvidenceFailure(userId, { at: now(), error: message }).catch(() => undefined);
    throw error;
  }
}

export type RequestRiskEvidenceRefreshResult = 'queued' | 'deduped' | 'failed';

export interface RequestRiskEvidenceRefreshAdapters {
  users: Pick<IUserRepository, 'claimRiskEvidenceRefresh' | 'releaseRiskEvidenceRefresh'>;
  /** Send the message to the riskEvidenceQueue with the given delay (seconds). */
  enqueue: (message: RiskEvidenceRefreshMessage, delaySeconds: number) => Promise<void>;
  logger: Pick<Logger, 'warn'>;
  now?: Date;
}

/**
 * Queue a debounced evidence refresh: at most one is pending per account, and it runs
 * RISK_EVIDENCE_DEBOUNCE_SECONDS later so a burst of activity is summarized once. Costs the caller
 * one conditional update plus, when it claims, one SQS send. Never throws: losing a refresh must not
 * fail a sign-in or a key creation, and the scheduled sweep repairs what was dropped.
 */
export async function requestRiskEvidenceRefresh(
  userId: string,
  trigger: RiskEvidenceTrigger,
  { users, enqueue, logger, now = new Date() }: RequestRiskEvidenceRefreshAdapters
): Promise<RequestRiskEvidenceRefreshResult> {
  let claimed = false;
  try {
    claimed = await users.claimRiskEvidenceRefresh(userId, {
      now,
      staleBefore: new Date(now.getTime() - RISK_EVIDENCE_STALE_CLAIM_MS),
      trigger,
    });
    if (!claimed) return 'deduped';
    await enqueue({ kind: 'refresh', userId, trigger, requestedAt: now }, RISK_EVIDENCE_DEBOUNCE_SECONDS);
    return 'queued';
  } catch (error) {
    logger.warn('Risk evidence refresh not queued', {
      userId,
      trigger,
      error: error instanceof Error ? error.message : String(error),
    });
    // A claim whose message never left would dedupe every request until it goes stale.
    if (claimed) await users.releaseRiskEvidenceRefresh(userId, now).catch(() => undefined);
    return 'failed';
  }
}

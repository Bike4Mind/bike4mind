import { Quest, TelemetryAuditLogModel } from '@bike4mind/database';
import { getClientIp, truncateIp } from '@bike4mind/server-utils/utils/ip';
import { regenerateUserTelemetryHashes } from './telemetryHashLookup';

export interface TelemetryDeletionResult {
  /** True only when the re-check ran and found no matching document still carrying telemetry. */
  verified: boolean;
  deletedCount: number;
  /** Matching documents that still carry telemetry after the unset. Absent when the re-check did not run. */
  remainingCount?: number;
}

/**
 * Deletes all telemetry data for a user who opted out (contextTelemetryLevel = 'none'), then
 * re-counts the documents that still match to confirm nothing is left.
 * Uses the same hash-based anonymization scheme to find matching telemetry records.
 *
 * Never throws: a failed delete, a failed re-check and a re-check that still finds documents all
 * resolve with `verified: false` and are audited as a failure, so the caller reports one outcome.
 * Safe to call again for the same user; a repeat run unsets whatever is left and re-checks.
 *
 * **Authorization:** This function performs no auth checks internally. It is a bulk
 * destructive operation (removes telemetry from up to 90 days of Quest documents).
 * Callers MUST verify that the request is authorized - e.g., the authenticated user
 * owns the account or is an admin - before invoking. Currently called only from
 * `pages/api/users/[id]/update.ts`, which is gated by `baseApi()` auth middleware.
 */
export async function triggerTelemetryDeletion(
  userId: string,
  req: { ip?: string; headers: Record<string, unknown> }
): Promise<TelemetryDeletionResult> {
  const startTime = Date.now();
  let deletedCount = 0;
  let remainingCount: number | undefined;
  let error: string | undefined;

  try {
    const hashes = await regenerateUserTelemetryHashes(userId);
    const filter = { 'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: hashes } };

    // $unset telemetry from matching Quest documents (telemetry is embedded, not separate collection).
    // includeDeleted: a soft-deleted quest still stores its telemetry, and softDeletePlugin's update
    // hook would otherwise skip it.
    const result = await Quest.updateMany(filter, { $unset: { 'promptMeta.contextTelemetry': '' } }).setOptions({
      includeDeleted: true,
    });
    deletedCount = result.modifiedCount;

    // softDeletePlugin never filters counts, so this reaches soft-deleted quests without the option.
    remainingCount = await Quest.countDocuments(filter);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Telemetry] Opt-out deletion failed:', error);
  }

  const verified = remainingCount === 0;
  if (!error && !verified) {
    console.error(`[Telemetry] Opt-out deletion left ${remainingCount} document(s) with telemetry`);
  }

  // Audit the deletion - wrapped in try/catch so audit failure doesn't mask the deletion outcome
  try {
    await TelemetryAuditLogModel.create({
      action: 'delete',
      userId,
      questId: 'bulk-opt-out',
      sourceIp: truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0])),
      userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
      outcome: verified ? 'success' : 'failure',
      durationMs: Date.now() - startTime,
      metadata: {
        deletedCount,
        verified,
        ...(remainingCount !== undefined && { remainingCount }),
        ...(error && { error }),
        reason: 'user_opt_out',
      },
    });
  } catch (auditErr) {
    console.warn(
      '[TelemetryAudit] Failed to log deletion:',
      auditErr instanceof Error ? auditErr.message : 'Unknown error'
    );
  }

  return { verified, deletedCount, ...(remainingCount !== undefined && { remainingCount }) };
}

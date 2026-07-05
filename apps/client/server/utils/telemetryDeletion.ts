import { Quest, TelemetryAuditLogModel } from '@bike4mind/database';
import { getClientIp, truncateIp } from './ip';
import { regenerateUserTelemetryHashes } from './telemetryHashLookup';

/**
 * Deletes all telemetry data for a user who opted out (contextTelemetryLevel = 'none').
 * Uses the same hash-based anonymization scheme to find matching telemetry records.
 * Awaited by caller - GDPR Article 17 requires verified deletion.
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
): Promise<void> {
  const startTime = Date.now();

  const hashes = await regenerateUserTelemetryHashes(userId);

  // $unset telemetry from matching Quest documents (telemetry is embedded, not separate collection)
  const result = await Quest.updateMany(
    { 'promptMeta.contextTelemetry.anonymousSessionId.hash': { $in: hashes } },
    { $unset: { 'promptMeta.contextTelemetry': '' } }
  );

  const durationMs = Date.now() - startTime;

  // Audit the deletion - wrapped in try/catch so audit failure doesn't mask successful deletion
  try {
    await TelemetryAuditLogModel.create({
      action: 'delete',
      userId,
      questId: 'bulk-opt-out',
      sourceIp: truncateIp(getClientIp(req as Parameters<typeof getClientIp>[0])),
      userAgent: (req.headers['user-agent'] as string) ?? 'unknown',
      outcome: 'success',
      durationMs,
      metadata: { deletedCount: result.modifiedCount, reason: 'user_opt_out' },
    });
  } catch (auditErr) {
    console.warn(
      '[TelemetryAudit] Failed to log deletion:',
      auditErr instanceof Error ? auditErr.message : 'Unknown error'
    );
  }
}

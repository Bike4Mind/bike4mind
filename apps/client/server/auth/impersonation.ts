import type { Request } from 'express';
import { SupportAccess, authSessionRepository, withTransaction } from '@bike4mind/database';
import { recordAdminActionForActor } from '@server/utils/adminAudit';
import type { AuditActor } from '@bike4mind/common';

export function impersonationLifetimeMs(): number {
  const minutes = Number(process.env.IMPERSONATION_TTL_MINUTES ?? 60);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)
    throw new Error('IMPERSONATION_TTL_MINUTES must be between 0 and 1440');
  return minutes * 60_000;
}

export function customerSupportAccess(
  row: { sid: string; startedAt: Date; expiresAt: Date; endedAt?: Date | null },
  now = new Date()
) {
  const endedAt = row.endedAt ?? (row.expiresAt <= now ? row.expiresAt : null);
  return {
    id: row.sid,
    message: 'Support accessed your account',
    startedAt: row.startedAt.toISOString(),
    endedAt: endedAt?.toISOString() ?? null,
    durationMs: Math.max(0, (endedAt ?? now).getTime() - row.startedAt.getTime()),
  };
}

export async function endImpersonation(req: Request, sid: string, actor: AuditActor) {
  await withTransaction(async () => {
    const row = await SupportAccess.findOne({ sid, adminId: actor.userId }).select('+reason');
    if (!row) return;
    const endedAt = new Date(Math.min(Date.now(), row.expiresAt.getTime()));
    const claimed = await SupportAccess.findOneAndUpdate(
      { sid, adminId: actor.userId, endedAt: null },
      { $set: { endedAt } },
      { new: true }
    );
    if (!claimed) return;
    await authSessionRepository.revokeBySid(sid);
    const entry = await recordAdminActionForActor(
      req,
      { ...actor, impersonatedUserId: row.userId },
      {
        action: 'user.impersonation.ended',
        target: { kind: 'user', id: row.userId, displayName: row.userId },
        summary: 'stopped impersonating the user',
        reason: row.reason,
        details: {
          durationMs: endedAt.getTime() - row.startedAt.getTime(),
          escalated: !!row.escalatedAt,
          expired: endedAt.getTime() === row.expiresAt.getTime(),
        },
        related: { impersonationSessionId: sid },
      }
    );
    if (!entry) throw new Error('Could not record the end of support access');
  });
}

export async function reconcileExpiredImpersonations(req: Request) {
  const rows = await SupportAccess.find({ endedAt: null, expiresAt: { $lte: new Date() } })
    .select('sid adminId')
    .sort({ expiresAt: 1 })
    .limit(100)
    .maxTimeMS(5000);
  for (const row of rows) {
    await endImpersonation(req, row.sid, {
      kind: 'user',
      scope: 'platform',
      userId: row.adminId,
      name: 'Support admin',
      wasAdmin: true,
    });
  }
}

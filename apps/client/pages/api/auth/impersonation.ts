import { AuthSessionModel, SupportAccess, authSessionRepository, withTransaction } from '@bike4mind/database';
import { isAuthSessionActive, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = baseApi({ auth: 'jwtOnly' })
  .get(async (req, res) => {
    const session = req.user?.sid ? await authSessionRepository.findBySid(req.user.sid) : null;
    if (!session?.impersonatedBy || !isAuthSessionActive(session))
      throw new UnauthorizedError('No active support session');
    return res.json({ expiresAt: session.impersonationExpiresAt, writeEnabled: !!session.impersonationWriteEnabled });
  })
  .post(async (req, res) => {
    if (!req.user?.impersonatedBy || !req.user.sid) throw new UnauthorizedError('No active support session');
    const reason = parseAdminActionReason(req.body?.reason);
    await withTransaction(async () => {
      const now = new Date();
      const session = await AuthSessionModel.findOneAndUpdate(
        {
          sid: req.user.sid,
          userId: req.user.id,
          impersonatedBy: req.user.impersonatedBy,
          revokedAt: null,
          expiresAt: { $gt: now },
          impersonationExpiresAt: { $gt: now },
          impersonationWriteEnabled: { $ne: true },
        },
        { $set: { impersonationWriteEnabled: true } },
        { new: true }
      );
      if (!session) throw new UnauthorizedError('Support session expired or changes already allowed');
      const row = await SupportAccess.findOneAndUpdate(
        { sid: session.sid, endedAt: null },
        { $set: { escalatedAt: now, escalationReason: reason } }
      );
      if (!row) throw new UnauthorizedError('No active support access record');
      await recordAdminActionFromRequest(req, {
        action: 'user.impersonation.escalated',
        target: { kind: 'user', id: req.user.id, displayName: req.user.name || req.user.id },
        summary: 'allowed changes for the remainder of the support session',
        reason,
        details: { escalated: true, expiresAt: session.impersonationExpiresAt },
        related: { impersonationSessionId: session.sid },
      });
    });
    return res.json({ writeEnabled: true });
  });
export default handler;

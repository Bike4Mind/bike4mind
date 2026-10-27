import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository, authFailLogRepository, withTransaction } from '@bike4mind/database';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

// POST /api/security/blocked-ips/evaluate
// Evaluates last 10 minutes and auto-blocks IPs with >=10 attempts.
// Writes to the IP blocklist, so it is admin-only like the rest of that control.
// If wired to an external scheduler, invoke it with an admin-scoped credential.
const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const result = await authFailLogRepository.getIPsWithHighAttempts(since, 10);
  const blocked: string[] = [];
  const auditFailed: string[] = [];
  for (const r of result) {
    let ipBlocked = false;
    try {
      await withTransaction(async () => {
        ipBlocked = false;
        // block() returns an existing active block untouched, so only a new block is audited.
        const reason = `Auto-blocked: ${r.attempts} attempts in 10 minutes`;
        const { created } = await blockedIPRepository.block(r.ip, reason);
        if (!created) return;
        ipBlocked = true;
        await recordAdminActionFromRequest(req, {
          action: 'security.blocked_ip.auto_added',
          target: { kind: 'settings', id: `blocked-ip:${r.ip}`, displayName: r.ip },
          summary: `auto-blocked ip ${r.ip}`,
          details: { ip: r.ip, attempts: r.attempts, evaluatedSince: since },
          reason,
        });
      });
      if (ipBlocked) blocked.push(r.ip);
    } catch (error) {
      if (ipBlocked) {
        // The audit or commit failed and rolled this block back; keep blocking the rest and fail the run after.
        req.logger?.error(`Auto-block of IP ${r.ip} not committed (audit or commit failed); block rolled back:`, error);
        auditFailed.push(r.ip);
        continue;
      }
      // Log error but continue blocking other IPs
      req.logger?.warn(`Failed to block IP ${r.ip}:`, error);
    }
  }
  if (auditFailed.length > 0) {
    return res.status(500).json({
      error: 'Audit or commit failed; these IPs were not blocked',
      auditFailed,
      blocked,
      evaluatedSince: since,
    });
  }
  return res.status(200).json({ blocked, evaluatedSince: since });
});

export default handler;

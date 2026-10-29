import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository, withTransaction } from '@bike4mind/database';
import { runOauthAbuseAutoBlock } from '@bike4mind/server-utils/security/oauthAbuseAutoBlock';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

// POST /api/security/blocked-ips/evaluate
// Manual trigger for the auto-block that the oauthAbuseAutoBlock cron runs every minute, using the
// same admin-set threshold, window and escalation. Writes to the IP blocklist, so it is admin-only.
// Unlike the cron, each new block here is audited inside its own transaction.
const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const auditFailed: string[] = [];
  const { blocked, evaluatedSince } = await runOauthAbuseAutoBlock({
    now: new Date(),
    deps: {
      block: async (ip, reason, options) => {
        let ipBlocked = false;
        try {
          await withTransaction(async () => {
            ipBlocked = false;
            // block() only extends an existing active block; only a new block is audited.
            const result = await blockedIPRepository.block(ip, reason, options);
            if (!result.created) return;
            ipBlocked = true;
            await recordAdminActionFromRequest(req, {
              action: 'security.blocked_ip.auto_added',
              target: { kind: 'settings', id: `blocked-ip:${ip}`, displayName: ip },
              summary: `auto-blocked ip ${ip}`,
              details: { ip, durationMs: options.durationMs, escalationLevel: options.escalationLevel },
              reason,
            });
          });
        } catch (error) {
          if (ipBlocked) {
            // The audit or commit failed and rolled this block back; the runner moves on, the run fails after.
            req.logger?.error(
              `Auto-block of IP ${ip} not committed (audit or commit failed); block rolled back:`,
              error
            );
            auditFailed.push(ip);
          }
          throw error;
        }
        return { created: ipBlocked };
      },
    },
  });
  const blockedIps = blocked.map(b => b.ip);
  if (auditFailed.length > 0) {
    return res.status(500).json({
      error: 'Audit or commit failed; these IPs were not blocked',
      auditFailed,
      blocked: blockedIps,
      evaluatedSince,
    });
  }
  return res.status(200).json({ blocked: blockedIps, evaluatedSince });
});

export default handler;

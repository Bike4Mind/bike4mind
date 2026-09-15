import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository, authFailLogRepository } from '@bike4mind/database';
import { ensureAdmin } from '@server/utils/errors';

// POST /api/security/blocked-ips/evaluate
// Evaluates last 10 minutes and auto-blocks IPs with >=10 attempts.
// Writes to the IP blocklist, so it is admin-only like the rest of that control.
// If wired to an external scheduler, invoke it with an admin-scoped credential.
const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const result = await authFailLogRepository.getIPsWithHighAttempts(since, 10);
  const blocked: string[] = [];
  for (const r of result) {
    try {
      await blockedIPRepository.block(r.ip, `Auto-blocked: ${r.attempts} attempts in 10 minutes`);
      blocked.push(r.ip);
    } catch (error) {
      // Log error but continue blocking other IPs
      req.logger?.warn(`Failed to block IP ${r.ip}:`, error);
    }
  }
  return res.status(200).json({ blocked, evaluatedSince: since });
});

export default handler;

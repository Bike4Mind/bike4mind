import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository, withTransaction } from '@bike4mind/database';
import { ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

// GET: list active blocked IPs (limit=10)
// POST: block ip { ip, reason }
// DELETE: unblock ip ?ip=1.2.3.4
// POST /evaluate endpoint lives in blocked-ips/evaluate.ts
//
// Managing the IP blocklist is an administrative security control; every method
// is restricted to admins.

const BlockSchema = z.object({ ip: z.string().min(1), reason: z.string().max(1000).optional() });

const handler = baseApi()
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const query = req.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || '10', 10), 50);
    const items = await blockedIPRepository.list(limit);
    res.status(200).json({ items });
  })
  .post(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const parsed = BlockSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    const { ip, reason } = parsed.data;
    const doc = await withTransaction(async () => {
      // block() returns an existing active block untouched, so only a new block is audited.
      const existing = await blockedIPRepository.isBlocked(ip);
      if (existing) return existing;
      const blocked = await blockedIPRepository.block(ip, reason);
      await recordAdminActionFromRequest(req, {
        action: 'security.blocked_ip.added',
        target: { kind: 'settings', id: `blocked-ip:${ip}`, displayName: ip },
        summary: `blocked ip ${ip}`,
        details: { ip, expiresAt: blocked.expiresAt },
        reason,
      });
      return blocked;
    });
    res.status(201).json({ item: doc });
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const query = req.query as { ip?: string };
    const body = req.body as { ip?: string } | undefined;
    const ip = query.ip || body?.ip;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const doc = await withTransaction(async () => {
      const unblocked = await blockedIPRepository.unblock(ip);
      if (unblocked) {
        await recordAdminActionFromRequest(req, {
          action: 'security.blocked_ip.removed',
          target: { kind: 'settings', id: `blocked-ip:${ip}`, displayName: ip },
          summary: `unblocked ip ${ip}`,
          details: { ip },
        });
      }
      return unblocked;
    });
    res.status(200).json({ item: doc });
  });

export const config = { api: { externalResolver: true } };
export default handler;

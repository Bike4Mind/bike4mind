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

const BlockSchema = z.object({ ip: z.string().min(1).max(64), reason: z.string().max(1000).optional() });
const UnblockSchema = BlockSchema.pick({ ip: true });

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
    const { doc, created } = await withTransaction(async () => {
      // block() only extends an existing active block; only a new block is audited.
      const result = await blockedIPRepository.block(ip, reason);
      if (!result.created) return result;
      const blocked = result.doc;
      await recordAdminActionFromRequest(req, {
        action: 'security.blocked_ip.added',
        target: { kind: 'settings', id: `blocked-ip:${ip}`, displayName: ip },
        summary: `blocked ip ${ip}`,
        details: { ip, expiresAt: blocked.expiresAt },
        reason,
      });
      return result;
    });
    // An IP already blocked keeps its existing row, reason and (never shorter) expiry.
    res.status(created ? 201 : 200).json({ item: doc, alreadyBlocked: !created });
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const query = req.query as { ip?: string };
    const body = req.body as { ip?: string } | undefined;
    const parsed = UnblockSchema.safeParse({ ip: query.ip ?? body?.ip });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    const doc = await withTransaction(async () => {
      const unblocked = await blockedIPRepository.unblock(parsed.data.ip);
      if (unblocked) {
        // unblock() matches on active alone, so a block past its expiry can still be removed here.
        await recordAdminActionFromRequest(req, {
          action: 'security.blocked_ip.removed',
          target: { kind: 'settings', id: `blocked-ip:${unblocked.ip}`, displayName: unblocked.ip },
          summary: `unblocked ip ${unblocked.ip}`,
          details: { ip: unblocked.ip, expiresAt: unblocked.expiresAt, wasExpired: unblocked.expiresAt <= new Date() },
        });
      }
      return unblocked;
    });
    res.status(200).json({ item: doc });
  });

export const config = { api: { externalResolver: true } };
export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository } from '@bike4mind/database';
import { ensureAdmin } from '@server/utils/errors';

// GET: list active blocked IPs (limit=10)
// POST: block ip { ip, reason }
// DELETE: unblock ip ?ip=1.2.3.4
// POST /evaluate endpoint lives in blocked-ips/evaluate.ts
//
// Managing the IP blocklist is an administrative security control; every method
// is restricted to admins.

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
    const body = req.body as { ip?: string; reason?: string };
    const { ip, reason } = body || {};
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const doc = await blockedIPRepository.block(ip, reason);
    res.status(201).json({ item: doc });
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const query = req.query as { ip?: string };
    const body = req.body as { ip?: string } | undefined;
    const ip = query.ip || body?.ip;
    if (!ip) return res.status(400).json({ error: 'ip is required' });
    const doc = await blockedIPRepository.unblock(ip);
    res.status(200).json({ item: doc });
  });

export const config = { api: { externalResolver: true } };
export default handler;

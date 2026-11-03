import { z } from 'zod';
import {
  CreateIpBlockRequestSchema,
  IP_BLOCK_DURATION_MS,
  ipBlockContains,
  parseIpRange,
  PERMANENT_IP_BLOCK_EXPIRES_AT,
} from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { blockedIPRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError, ensureAdmin } from '@bike4mind/server-utils/utils/errors';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

// GET: list active blocked IPs (limit=10, max 50)
// POST: block { ip (address or CIDR range), scope, duration, reason }
// DELETE: unblock { id, reason } (or the legacy ?ip=1.2.3.4)
// POST /evaluate endpoint lives in blocked-ips/evaluate.ts
//
// Managing the IP blocklist is an administrative security control; every method
// is restricted to admins.

const UnblockSchema = z.union([
  z.object({ id: z.string().min(1).max(64) }),
  z.object({ ip: z.string().min(1).max(64) }),
]);

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
    const parsed = CreateIpBlockRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    const { scope, duration, reason } = parsed.data;
    // The schema has already refused anything parseIpRange cannot read.
    const range = parseIpRange(parsed.data.ip)!;
    const ip = range.canonical;

    // A login-scope block of the admin's own network would lock them out at their next sign-in.
    if (ipBlockContains({ ip, rangeStart: range.start, rangeEnd: range.end }, getClientIp(req))) {
      throw new BadRequestError('This would block your own IP address.');
    }

    const durationMs = IP_BLOCK_DURATION_MS[duration];
    const expiresAt = durationMs === null ? PERMANENT_IP_BLOCK_EXPIRES_AT : new Date(Date.now() + durationMs);
    const { doc, created, extended } = await withTransaction(async () => {
      const result = await blockedIPRepository.block(ip, reason, {
        expiresAt,
        scope,
        source: 'manual',
        blockedBy: { id: req.user.id, name: req.user.email ?? req.user.username },
      });
      if (!result.created && !result.extended) return result;
      await recordAdminActionFromRequest(req, {
        action: 'security.blocked_ip.added',
        target: { kind: 'settings', id: `blocked-ip:${ip}`, displayName: ip },
        summary: result.created
          ? `blocked ip ${ip} (${scope}, ${duration})`
          : `extended block of ip ${ip} (${duration})`,
        details: { ip, scope, duration, expiresAt: result.doc.expiresAt, extendedExisting: result.extended },
        reason,
      });
      return result;
    });
    // An IP already blocked keeps its existing row and reason; its expiry only ever grows.
    res.status(created ? 201 : 200).json({ item: doc, alreadyBlocked: !created, extended });
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const query = req.query as { ip?: string; id?: string };
    const body = req.body as { ip?: string; id?: string; reason?: unknown } | undefined;
    const id = query.id ?? body?.id;
    const parsed = UnblockSchema.safeParse(id ? { id } : { ip: query.ip ?? body?.ip });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    // Lifting a block removes a security control, so it carries a reason like any other audited admin action.
    const reason = parseAdminActionReason(body?.reason);
    const doc = await withTransaction(async () => {
      const unblocked =
        'id' in parsed.data
          ? await blockedIPRepository.unblockById(parsed.data.id)
          : await blockedIPRepository.unblock(parsed.data.ip);
      if (unblocked) {
        // Both unblock paths match on active alone, so a block past its expiry can still be removed here.
        await recordAdminActionFromRequest(req, {
          action: 'security.blocked_ip.removed',
          target: { kind: 'settings', id: `blocked-ip:${unblocked.ip}`, displayName: unblocked.ip },
          summary: `unblocked ip ${unblocked.ip}`,
          details: {
            ip: unblocked.ip,
            scope: unblocked.scope ?? 'login',
            expiresAt: unblocked.expiresAt,
            wasExpired: unblocked.expiresAt <= new Date(),
          },
          reason,
        });
      }
      return unblocked;
    });
    res.status(200).json({ item: doc });
  });

export const config = { api: { externalResolver: true } };
export default handler;

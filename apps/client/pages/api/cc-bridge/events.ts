import { activeCodeAgentRepository, codeAgentEventRepository } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/utils';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ensureTavernAccess } from '@server/utils/errors';
import { z } from 'zod';

const QuerySchema = z.object({
  instanceId: z.string().min(1).max(128),
  /** Cursor: ISO timestamp - return events strictly older than this. */
  before: z.string().datetime().optional(),
  /** Page size (1-200, default 50). */
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Rate limit the endpoint to blunt enumeration attempts: instanceIds are
// opaque UUIDs so naive guessing is already infeasible, but a generous cap
// keeps a malicious authenticated session from sustained probing without
// impacting legitimate modal opens (a few calls per page view).
const EVENTS_RATE_LIMIT = 120;
const ONE_MINUTE_MS = 60 * 1000;

/**
 * GET /api/cc-bridge/events
 *
 * Read-only transcript fetch for the `CodeAgentPanel` in the tavern.
 * Returns events newest-first for an `ActiveCodeAgent` the requesting
 * user owns. Pagination is cursor-based on `createdAt`.
 *
 * Auth: standard session auth. The bridge's own API key is NOT accepted
 * here - this is a user-facing endpoint.
 */
const handler = baseApi({ auth: true })
  .use(rateLimit({ limit: EVENTS_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .get(
    asyncHandler(async (req, res) => {
      req.logger.updateMetadata({ endpoint: 'cc-bridge/events' });

      const userId = req.user?.id;
      if (!userId) {
        throw new BadRequestError('Missing authenticated user');
      }
      ensureTavernAccess(req.user);

      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({
          error: 'Invalid query params',
          details: parsed.error.flatten(),
        });
      }

      const { instanceId, before, limit } = parsed.data;

      // Ownership check - an instance the caller doesn't own returns 404
      // (not 403) to avoid leaking whether the instanceId exists. Single
      // compound-indexed query so we don't give a timing side-channel
      // between "unknown id" and "id you don't own".
      const agent = await activeCodeAgentRepository.findByInstanceIdForUser(instanceId, userId);
      if (!agent) {
        return res.status(404).json({ error: 'Instance not found' });
      }

      const events = await codeAgentEventRepository.listByInstance(userId, instanceId, {
        before: before ? new Date(before) : undefined,
        limit,
      });

      // Shape the response so the client doesn't have to know about Mongo
      // doc internals. `nextCursor` is the createdAt of the last (oldest)
      // event; callers pass it back as `before` to page further.
      const shaped = events.map(e => ({
        id: String(e._id),
        type: e.type,
        status: e.status,
        role: e.role,
        text: e.text,
        tool: e.tool,
        toolUseId: e.toolUseId,
        isError: e.isError,
        requestId: e.requestId,
        toolName: e.toolName,
        allow: e.allow,
        resolvedBy: e.resolvedBy,
        occurredAt: e.occurredAt.toISOString(),
        createdAt: e.createdAt.toISOString(),
      }));

      const nextCursor =
        events.length === (limit ?? 50) && events.length > 0 ? events[events.length - 1].createdAt.toISOString() : null;

      return res.status(200).json({
        events: shaped,
        nextCursor,
      });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

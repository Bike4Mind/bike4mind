// Share several files or notebooks with the same recipients and permissions in one request
// POST /api/invites/batch

import { BadRequestError, InviteType, MAX_BULK_ITEMS } from '@bike4mind/common';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { createDocumentInvite, createInviteBodySchema } from '@server/managers/createDocumentInvite';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { z } from 'zod';

// Project, group and organization invites stay on their own routes, which carry their own key
// scopes and budgets (pages/api/projects/[id]/invites.ts, pages/api/[type]/[id]/invites).
const BatchInviteBodySchema = createInviteBodySchema.extend({
  type: z.enum([InviteType.FabFile, InviteType.Session]),
  ids: z
    .array(z.string().refine(isValidObjectId, 'Invalid document id'))
    .min(1, 'Provide at least one document id')
    .max(MAX_BULK_ITEMS, `At most ${MAX_BULK_ITEMS} document ids`),
});

type BatchInviteResult = { id: string; ok: boolean; link?: string; error?: string; rateLimited?: boolean };
type BatchInviteResponse = { results: BatchInviteResult[]; okCount: number; rateLimitMessage?: string };

const statusOf = (error: unknown) => (error as { statusCode?: unknown })?.statusCode;

// Same rule as invites/bulk.ts: only a client-facing HTTP error's message reaches the caller.
const toItemError = (error: unknown) => {
  const status = statusOf(error);
  return typeof status === 'number' && status < 500 && error instanceof Error ? error.message : 'Could not share';
};

const handler = baseApi().post(
  outboundActionGate(),
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    const parsed = BatchInviteBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
    }
    const { type, ids: rawIds, ...body } = parsed.data;
    const ids = [...new Set(rawIds)];

    // Sequential so each item reserves its own send budget exactly as the single-item route does.
    // Once the budget refuses, later items in the same window would be too, so the rest are not tried.
    const results: BatchInviteResult[] = [];
    let rateLimitMessage: string | undefined;
    for (const id of ids) {
      if (rateLimitMessage) {
        results.push({ id, ok: false, rateLimited: true, error: rateLimitMessage });
        continue;
      }
      try {
        const invite = await createDocumentInvite(req, { type, id, body });
        results.push({ id, ok: true, link: invite.link });
      } catch (error) {
        if (statusOf(error) === 429) {
          rateLimitMessage = error instanceof Error ? error.message : 'Too many invitations. Try again later.';
          results.push({ id, ok: false, rateLimited: true, error: rateLimitMessage });
          continue;
        }
        req.logger.warn('[invites/batch] invite create failed', { documentId: id, type, error });
        results.push({ id, ok: false, error: toItemError(error) });
      }
    }

    const response: BatchInviteResponse = {
      results,
      okCount: results.filter(r => r.ok).length,
      ...(rateLimitMessage && { rateLimitMessage }),
    };
    return res.json(response);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

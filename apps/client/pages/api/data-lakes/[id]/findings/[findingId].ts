import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, dataLakeFindingRepository } from '@bike4mind/database';
import { LAKE_FINDING_RESOLUTION_MAX_CHARS } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

/**
 * The two state changes a curator can make, as a discriminated union rather than a partial patch:
 * resolving and assigning have different guards (one is a once-only terminal transition, the other
 * is idempotent and legal in any status), so a body that could carry both would have to answer what
 * happens when one half succeeds and the other does not.
 *
 * `resolve` and `dismiss` mirror the proposal queue's `approve` / `decline` - the action IS the
 * terminal status, so there is no way to send an action and a contradicting status.
 */
const UpdateBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('resolve'),
    resolution: z.string().trim().max(LAKE_FINDING_RESOLUTION_MAX_CHARS).optional(),
  }),
  z.object({
    action: z.literal('dismiss'),
    resolution: z.string().trim().max(LAKE_FINDING_RESOLUTION_MAX_CHARS).optional(),
  }),
  z.object({
    // Null clears the assignment. Explicitly nullable rather than optional so "unassign" is a thing
    // a caller can say, instead of being indistinguishable from "leave it alone".
    action: z.literal('assign'),
    assigneeUserId: z.string().trim().min(1).nullable(),
  }),
]);

/**
 * POST /api/data-lakes/:id/findings/:findingId - rule on one detected corpus problem (#3039).
 *
 * DETECT, DO NOT REJECT (#2242). Resolving or dismissing a finding records a HUMAN'S JUDGEMENT and
 * mutates nothing else: no document is removed, re-chunked, re-ingested or gated as a result. If a
 * later issue wants a resolution to change a corpus, that has to be argued on its own merits - it
 * is not something this route may be quietly widened into.
 *
 * MANAGE-gated via `assertLakeWriteAccess`, matching the list route and `inconsistencies.ts`.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    assertDataLakeWriteScope(req);
    const { id, findingId } = req.query as { id: string; findingId: string };
    const body = UpdateBody.parse(req.body);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    // Belongs-to-lake is checked here rather than trusted from the path: the gate above authorized a
    // LAKE, so without this a caller who manages one lake could rule on any finding id in the
    // database by quoting their own lake in the URL. Not-found rather than forbidden, so the refusal
    // leaks nothing about findings in lakes the caller cannot see.
    const existing = await dataLakeFindingRepository.findById(findingId);
    if (!existing || existing.lakeId !== lake.id) throw new NotFoundError('Finding not found');

    if (body.action === 'assign') {
      // Shape-validated only. Whether the assignee can actually MANAGE this lake is deliberately not
      // checked here: answering it needs the assignee's own org membership resolved into an
      // AccessContext, which is a different read than this route holds, and half-checking it (does
      // the user row exist?) would assure a caller of something it had not established. The picker
      // that produces this id is #3044/#3045; a dead assignment is visible and reversible, and no
      // assignment grants any access on its own.
      const assigned = await dataLakeFindingRepository.assignFinding(findingId, body.assigneeUserId);
      if (!assigned) throw new NotFoundError('Finding not found');
      return res.json({ data: assigned });
    }

    const resolved = await dataLakeFindingRepository.resolveFinding(findingId, {
      status: body.action === 'resolve' ? 'resolved' : 'dismissed',
      resolvedByUserId: ctx.userId,
      resolvedAt: new Date(),
      resolution: body.resolution,
    });
    // Null means the row was not open. That is the double-resolve guard reporting a race or a
    // double-click, not a missing row - the belongs-to-lake read above already proved it exists.
    if (!resolved) {
      throw new BadRequestError('This finding has already been ruled on');
    }

    return res.json({ data: resolved });
  });

export const config = { api: { externalResolver: true } };

export default handler;

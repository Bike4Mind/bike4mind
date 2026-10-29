import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { workItemRepository } from '@bike4mind/database';
import { ILoop, IWorkItem, WorkItemPatch } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { verifyOrgAccess } from '@bike4mind/server-utils/utils/orgAccess';
import { assertDependenciesUsable } from '@server/utils/workItemDependencies';
import { assertLoopTicketAccess, makeDueIfReady, ticketMovePatch } from '@server/utils/loopTickets';
import {
  validateWorkItemDependencies,
  validateWorkItemDescription,
  validateWorkItemStatus,
  validateWorkItemTitle,
  WORK_ITEM_RATE_LIMIT,
  WORK_ITEM_RATE_WINDOW_MS,
} from '@server/utils/workItemValidation';

/** Loop tickets are session-only: an API key (the CLI) cannot read or write one (it still sees them in /graph). */
async function findVisible(req: { user?: { id: string }; apiKeyInfo?: unknown }, id: string) {
  const item = await workItemRepository.findByIdForUser(id, req.user!.id);
  return item && !(item.loopId && req.apiKeyInfo) ? item : null;
}

const handler = baseApi()
  // Explicit bucket: the raw pathname embeds the item id, which would give each
  // id its own counter and make the limit per-item rather than per-route.
  .use(rateLimit({ limit: WORK_ITEM_RATE_LIMIT, windowMs: WORK_ITEM_RATE_WINDOW_MS, bucket: 'work-items-item' }))
  .get(async (req, res) => {
    const id = String(req.query.id);
    const item = await findVisible(req, id);
    if (!item) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }
    res.json(item);
  })
  .patch(async (req, res) => {
    const id = String(req.query.id);
    // description is widened to allow the explicit null/'' that clears it.
    const body = req.body as Partial<Omit<IWorkItem, 'description' | 'loopId'>> & {
      description?: string | null;
      loopId?: string | null;
      reason?: unknown;
    };

    const existing = await findVisible(req, id);
    if (!existing) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }

    const patch: WorkItemPatch = {};

    if (body.title !== undefined) patch.title = validateWorkItemTitle(body.title);
    if (body.description !== undefined) patch.description = validateWorkItemDescription(body.description);

    if (body.organizationId !== undefined) {
      await verifyOrgAccess({ id: req.user!.id, isAdmin: Boolean(req.user!.isAdmin) }, body.organizationId);
      patch.organizationId = body.organizationId;
    }

    if (body.dependencies !== undefined) {
      const dependencies = validateWorkItemDependencies(body.dependencies) ?? [];
      await assertDependenciesUsable(req.user!.id, dependencies, id);
      patch.dependencies = dependencies;
    }

    const status = validateWorkItemStatus(body.status);
    const movesLoop = body.loopId !== undefined && body.loopId !== existing.loopId;
    let loop: ILoop | undefined;
    if (body.loopId === null) {
      if (existing.loopId) Object.assign(patch, { loopId: null, stage: null, statusReason: null, executionId: null });
    } else if (body.loopId !== undefined || existing.loopId) {
      loop = await assertLoopTicketAccess(req, body.loopId ?? existing.loopId);
    }

    if (loop) {
      // A ticket moved into another loop starts over in that loop.
      if (movesLoop || body.stage !== undefined || status !== undefined) {
        Object.assign(
          patch,
          { loopId: loop.id },
          ticketMovePatch(loop, movesLoop ? undefined : existing, { stage: body.stage, status, reason: body.reason })
        );
      }
    } else if (body.stage !== undefined) {
      throw new BadRequestError('stage is only valid on a loop ticket');
    } else if (status !== undefined && status !== existing.status) {
      patch.status = status;
      // closedAt tracks the latest close, and is cleared when the item reopens.
      patch.closedAt = status === 'closed' ? new Date() : null;
    }

    const updated = await workItemRepository.updateForUser(id, req.user!.id, patch);
    if (!updated) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }

    if (loop) await makeDueIfReady(loop);
    res.json(updated);
  })
  .delete(async (req, res) => {
    const id = String(req.query.id);
    if (req.apiKeyInfo && !(await findVisible(req, id))) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }
    const deleted = await workItemRepository.softDeleteForUser(id, req.user!.id);
    if (!deleted) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }
    res.status(204).end();
  });

export default handler;

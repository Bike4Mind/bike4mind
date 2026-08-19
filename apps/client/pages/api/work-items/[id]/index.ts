import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { workItemRepository } from '@bike4mind/database';
import { IWorkItem, WorkItemPatch } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { assertDependenciesUsable } from '@server/utils/workItemDependencies';
import {
  validateWorkItemDependencies,
  validateWorkItemDescription,
  validateWorkItemStatus,
  validateWorkItemTitle,
  WORK_ITEM_RATE_LIMIT,
  WORK_ITEM_RATE_WINDOW_MS,
} from '@server/utils/workItemValidation';

const handler = baseApi()
  // Explicit bucket: the raw pathname embeds the item id, which would give each
  // id its own counter and make the limit per-item rather than per-route.
  .use(rateLimit({ limit: WORK_ITEM_RATE_LIMIT, windowMs: WORK_ITEM_RATE_WINDOW_MS, bucket: 'work-items-item' }))
  .get(async (req, res) => {
    const id = String(req.query.id);
    const item = await workItemRepository.findByIdForUser(id, req.user!.id);
    if (!item) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }
    res.json(item);
  })
  .patch(async (req, res) => {
    const id = String(req.query.id);
    // description is widened to allow the explicit null/'' that clears it.
    const body = req.body as Partial<Omit<IWorkItem, 'description'>> & { description?: string | null };

    const existing = await workItemRepository.findByIdForUser(id, req.user!.id);
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
    if (status !== undefined && status !== existing.status) {
      patch.status = status;
      // closedAt tracks the latest close, and is cleared when the item reopens.
      patch.closedAt = status === 'closed' ? new Date() : null;
    }

    const updated = await workItemRepository.updateForUser(id, req.user!.id, patch);
    if (!updated) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }

    res.json(updated);
  })
  .delete(async (req, res) => {
    const id = String(req.query.id);
    const deleted = await workItemRepository.softDeleteForUser(id, req.user!.id);
    if (!deleted) {
      throw new NotFoundError('Work item not found for id: ' + id);
    }
    res.status(204).end();
  });

export default handler;

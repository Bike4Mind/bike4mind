import { baseApi } from '@client/server/middlewares/baseApi';
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
} from '@server/utils/workItemValidation';

const handler = baseApi()
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
    const body = req.body as Partial<IWorkItem>;

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

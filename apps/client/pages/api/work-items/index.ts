import { Request } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { workItemRepository } from '@bike4mind/database';
import { IWorkItem } from '@bike4mind/common';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { assertDependenciesUsable } from '@server/utils/workItemDependencies';
import {
  parseStatusFilter,
  validateWorkItemDependencies,
  validateWorkItemDescription,
  validateWorkItemStatus,
  validateWorkItemTitle,
  WORK_ITEM_RATE_LIMIT,
  WORK_ITEM_RATE_WINDOW_MS,
} from '@server/utils/workItemValidation';

const ALLOWED_ORDER_BY = new Set(['createdAt', 'updatedAt', 'title']);
const ALLOWED_ORDER_DIRECTION = new Set(['asc', 'desc']);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const handler = baseApi()
  .use(rateLimit({ limit: WORK_ITEM_RATE_LIMIT, windowMs: WORK_ITEM_RATE_WINDOW_MS, bucket: 'work-items-collection' }))
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const {
      status,
      organizationId,
      query = '',
      page = '1',
      limit = String(DEFAULT_LIMIT),
      orderBy = 'updatedAt',
      orderDirection = 'desc',
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    // Cap the page size so a client can't ask for the whole backlog at once.
    const safeLimit = Math.min(Math.max(Number.isFinite(limitNum) ? limitNum : DEFAULT_LIMIT, 1), MAX_LIMIT);
    const safePage = Math.max(Number.isFinite(pageNum) ? pageNum : 1, 1);
    const safeOrderBy = (ALLOWED_ORDER_BY.has(orderBy) ? orderBy : 'updatedAt') as 'createdAt' | 'updatedAt' | 'title';
    const safeOrderDirection = (ALLOWED_ORDER_DIRECTION.has(orderDirection) ? orderDirection : 'desc') as
      'asc' | 'desc';

    // No org-access check on the read path: the filter can only narrow a result
    // set that is already hard-scoped to the caller's own userId, so gating it
    // would 404 a plain org member without protecting anything.
    const statusFilter = parseStatusFilter(status);

    const result = await workItemRepository.listForUser(
      req.user!.id,
      {
        ...(statusFilter && { status: statusFilter }),
        ...(organizationId && { organizationId }),
        ...(query && { search: query }),
      },
      { page: safePage, limit: safeLimit },
      { by: safeOrderBy, direction: safeOrderDirection }
    );

    res.json(result);
  })
  .post(async (req, res) => {
    const body = req.body as Partial<IWorkItem>;

    const title = validateWorkItemTitle(body.title);
    const description = validateWorkItemDescription(body.description);
    const status = validateWorkItemStatus(body.status) ?? 'open';
    const dependencies = validateWorkItemDependencies(body.dependencies) ?? [];

    if (body.organizationId) {
      await verifyOrgAccess({ id: req.user!.id, isAdmin: Boolean(req.user!.isAdmin) }, body.organizationId);
    }

    await assertDependenciesUsable(req.user!.id, dependencies);

    const created = await workItemRepository.create({
      userId: req.user!.id,
      ...(body.organizationId && { organizationId: body.organizationId }),
      title,
      // On create there is nothing to clear, so the clearing value is just an omission.
      ...(description ? { description } : {}),
      status,
      dependencies,
      ...(status === 'closed' && { closedAt: new Date() }),
    } as Omit<IWorkItem, 'id' | 'createdAt' | 'updatedAt'>);

    res.status(201).json(created);
  });

export default handler;

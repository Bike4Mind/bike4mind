// apps/client/pages/api/skills/index.ts
import { Request } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { SkillCreateBody, insertSkill, resolveCreateScope, validateNewSkill } from '@server/skills/skillWrite';
import { ShareableSkill, canManageSkillSharingWith, redactShareRosterForViewer } from '@server/utils/skillAccess';
import { attachMarketStatus } from '@server/skillMarket/marketStatus';

const ALLOWED_ORDER_BY = new Set(['createdAt', 'updatedAt', 'name']);
const ALLOWED_ORDER_DIRECTION = new Set(['asc', 'desc']);

const handler = baseApi({ requiredScopes: [ApiKeyScope.SKILLS_WRITE], grandfatherLegacyKeys: true })
  .get<Request<{}, {}, {}, Record<string, string>>>(async (req, res) => {
    const { query = '', page = '1', limit = '10', orderBy = 'updatedAt', orderDirection = 'desc' } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    // Cap the page size so a malicious client can't ask for a million docs at once.
    const safeLimit = Math.min(Math.max(Number.isFinite(limitNum) ? limitNum : 10, 1), 100);
    const safePage = Math.max(Number.isFinite(pageNum) ? pageNum : 1, 1);
    // Validate orderBy / orderDirection against an allow-list so the caller
    // can't sort by an arbitrary indexed field.
    const safeOrderBy = (ALLOWED_ORDER_BY.has(orderBy) ? orderBy : 'updatedAt') as 'createdAt' | 'updatedAt' | 'name';
    const safeOrderDirection = (ALLOWED_ORDER_DIRECTION.has(orderDirection) ? orderDirection : 'desc') as
      'asc' | 'desc';

    // Surface system skills to admins and org-scoped skills to the orgs they
    // administer, so a creator can find a scoped skill in their listing.
    const isAdmin = Boolean(req.user!.isAdmin);
    const adminOrganizationIds = await organizationRepository.findIdsAdministeredBy(req.user!.id);

    const result = await skillRepository.searchAccessible(
      req.user!.id,
      query,
      {},
      { page: safePage, limit: safeLimit },
      { by: safeOrderBy, direction: safeOrderDirection },
      { isAdmin, adminOrganizationIds }
    );

    // Redact each row's share roster for callers who can't manage that skill -
    // otherwise a global-read (or scoped) skill leaks who it's shared with via
    // the list. Manage-check is synchronous here: admin context is already
    // resolved, so no per-row org lookup. Mirrors the single-skill GET.
    const actorId = req.user!.id;
    const data = result.data.map(skill =>
      redactShareRosterForViewer(
        skill as ShareableSkill,
        actorId,
        canManageSkillSharingWith(skill as ShareableSkill, { actorId, isAdmin, adminOrganizationIds })
      )
    );

    // Files are hashed for locallyModified, then dropped: up to 512 KB per row, and GET /api/skills/:id has them.
    const withStatus = await attachMarketStatus(data);
    res.json({ ...result, data: withStatus.map(({ files: _files, ...skill }) => skill) });
  })
  .post(async (req, res) => {
    const body = req.body as SkillCreateBody;
    const fields = validateNewSkill(body);
    const scope = await resolveCreateScope(body, { id: req.user!.id, isAdmin: Boolean(req.user!.isAdmin) });
    res.status(201).json(await insertSkill(fields, scope));
  });

export default handler;

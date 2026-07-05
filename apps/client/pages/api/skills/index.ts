// apps/client/pages/api/skills/index.ts
import { Request } from 'express';
import { baseApi } from '@client/server/middlewares/baseApi';
import { skillRepository } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { ISkill, ISkillDocument } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';
import {
  validateSkillName,
  validateSkillDescription,
  validateSkillBody,
  validateSkillArgumentHint,
  validateSkillAllowedTools,
} from '@server/utils/skillValidation';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { ensureAdmin } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { ShareableSkill, canManageSkillSharingWith, redactShareRosterForViewer } from '@server/utils/skillAccess';

const ALLOWED_ORDER_BY = new Set(['createdAt', 'updatedAt', 'name']);
const ALLOWED_ORDER_DIRECTION = new Set(['asc', 'desc']);

/** Scope fields written to the new skill - exactly one is set (model invariant). */
type SkillScope = { userId: string } | { organizationId: string } | { isSystem: true };

/**
 * Resolve and authorize the scope for a new skill from the optional
 * `scope` payload. Defaults to user-scoped (backward compatible). Org-scoped
 * creation requires the caller to be an admin/owner/manager of that org;
 * system-scoped creation requires a super-admin.
 */
async function resolveCreateScope(
  body: Partial<ISkill> & { scope?: { organizationId?: string; isSystem?: boolean } },
  user: { id: string; isAdmin: boolean }
): Promise<SkillScope> {
  const scope = body.scope;
  if (!scope || (!scope.organizationId && !scope.isSystem)) {
    return { userId: user.id };
  }
  if (scope.organizationId && scope.isSystem) {
    throw new BadRequestError('A skill cannot be both organization-scoped and system-scoped');
  }

  if (scope.isSystem) {
    // System skills are global built-ins - super-admin only.
    ensureAdmin(user.isAdmin);
    return { isSystem: true };
  }

  // Org-scoped: verifyOrgAccess throws NotFound/Forbidden if the caller isn't
  // an admin, owner, or manager of the target organization.
  await verifyOrgAccess(user, scope.organizationId as string);
  return { organizationId: scope.organizationId as string };
}

const handler = baseApi()
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
      | 'asc'
      | 'desc';

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

    res.json({ ...result, data });
  })
  .post(async (req, res) => {
    const body = req.body as Partial<ISkill> & { scope?: { organizationId?: string; isSystem?: boolean } };

    const name = validateSkillName(body.name);
    const description = validateSkillDescription(body.description);
    const skillBody = validateSkillBody(body.body);
    const argumentHint = validateSkillArgumentHint(body.argumentHint);
    const allowedTools = validateSkillAllowedTools(body.allowedTools);

    const scope = await resolveCreateScope(body, { id: req.user!.id, isAdmin: Boolean(req.user!.isAdmin) });

    try {
      const created = await skillRepository.create({
        name,
        description,
        body: skillBody,
        ...(argumentHint !== undefined && { argumentHint }),
        ...(allowedTools !== undefined && { allowedTools }),
        disableModelInvocation: Boolean(body.disableModelInvocation),
        ...scope,
        isGlobalRead: false,
        isGlobalWrite: false,
        users: [],
        groups: [],
      } as Omit<ISkillDocument, 'id' | 'createdAt' | 'updatedAt'>);

      res.status(201).json(created);
    } catch (error) {
      // Uniqueness is enforced by a partial unique index on (name, userId)
      // where deletedAt: null - catching the duplicate-key error here keeps
      // the create path atomic AND still yields a friendly 400.
      if (isDuplicateKeyError(error)) {
        throw new BadRequestError(`A skill named "${name}" already exists`);
      }
      throw error;
    }
  });

export default handler;

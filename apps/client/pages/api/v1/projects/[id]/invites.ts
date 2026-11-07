/**
 * GET  /api/v1/projects/{id}/invites - the public, cursor-paginated twin of GET /api/projects/[id]/invites.
 * POST /api/v1/projects/{id}/invites - the public twin of POST /api/projects/[id]/invites.
 *
 * Both render invites through toSharerInviteViews, so withheld recipient addresses and the token stay
 * off the wire; the token reaches the caller only as the create response's `link`.
 */
import {
  createProjectInviteContract,
  InviteType,
  listProjectInvitesContract,
  NotFoundError,
  Permission,
} from '@bike4mind/common';
import { inviteRepository, projectRepository } from '@bike4mind/database';
import { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { createProjectInvite } from '@server/projects/projectSharingMutations';
import { toPublicProjectInvite } from '@server/projects/toPublicProjectInvite';
import { paginateById } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';

const CURSOR_SCOPE = 'v1.projects.invites';

const listRoute = nextRouteForContract(listProjectInvitesContract, {
  rateLimit: perUserRateLimit('GET /api/v1/projects/[id]/invites'),
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  const { limit, cursor, status } = req.validatedQuery;
  if (!isValidObjectId(id)) throw new NotFoundError('Project not found');

  // Share-level, like the SPA list: it names pending invitees, so a plain member must not reach it.
  const project = await projectRepository.shareable.findShareAccessById(req.user, id);
  if (!project) throw new NotFoundError('Project not found');

  const invites = (await inviteRepository.findAllByDocumentId(project.id))
    .filter(invite => invite.type === InviteType.Project)
    .filter(invite => !status || (invite.recipients?.[status]?.length ?? 0) > 0)
    .map(invite => ({ ...invite, id: String(invite.id) }));
  const page = paginateById(invites, { limit, cursor, scope: CURSOR_SCOPE });
  const views = await toSharerInviteViews(page.items, req.user);

  return res.json({ data: views.map(toPublicProjectInvite), next_cursor: page.nextCursor });
});

const createRoute = nextRouteForContract(createProjectInviteContract, {
  rateLimit: perUserRateLimit('POST /api/v1/projects/[id]/invites'),
}).post(async (req, res) => {
  await assertOutboundActionAllowed(req.user, req);
  const { permissions, recipients, description, expires_at: expiresAt } = req.validated;
  if (expiresAt !== undefined && new Date(expiresAt) <= new Date()) {
    throw new UnprocessableEntityError('expires_at must be in the future');
  }

  const { view, link } = await createProjectInvite(
    { user: req.user, ability: req.ability, logger: req.logger },
    req.validatedParams.id,
    {
      permissions: permissions as Permission[],
      recipients,
      description,
      expiresAt: expiresAt === undefined ? undefined : new Date(expiresAt),
    }
  );

  return res.json({ ...toPublicProjectInvite(view), link });
});

export const config = {
  api: { externalResolver: true },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });

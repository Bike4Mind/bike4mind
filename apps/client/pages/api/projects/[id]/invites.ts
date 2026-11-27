import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import {
  assertProjectsReadScope,
  assertProjectsWriteScope,
  PROJECTS_READ_OR_WRITE_SCOPES,
} from '@server/projects/projectScopes';
import { createProjectInvite } from '@server/projects/projectSharingMutations';
import { inviteRepository, projectRepository } from '@bike4mind/database';
import { projectService } from '@bike4mind/services';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Permission } from '@bike4mind/common';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import { MAX_INVITE_MESSAGE_LENGTH, MAX_INVITE_RECIPIENTS } from '@server/utils/inviteSendLimits';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';

// Loose because the Add Members modal sends one request per selected user. The mail itself is
// bounded per recipient by reserveInviteSendBudget.
const PROJECT_INVITE_RATE_LIMIT = {
  limit: 100,
  windowMs: 60 * 60 * 1000,
  bucket: 'POST /api/projects/[id]/invites',
} as const;

// z.enum(Permission) produces Permission[] so the service type is satisfied.
const createInviteBodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
  recipients: z.string().array().max(MAX_INVITE_RECIPIENTS).optional(),
  description: z.string().max(MAX_INVITE_MESSAGE_LENGTH).optional(),
  // null is the client's "no expiry" (hooks/data/invites.ts DataInput) -- map to undefined so
  // the service's 100-year prefault applies. z.coerce.date(null) would silently produce epoch.
  expiresAt: z.preprocess(
    v => (v === null ? undefined : v),
    z.coerce.date().min(new Date(), 'expiresAt must be in the future').optional()
  ),
  available: z.number().optional(),
});

// baseApi's scope gate is per route, so it admits either projects scope and each method asserts its own.
const handler = baseApi({ requiredScopes: PROJECTS_READ_OR_WRITE_SCOPES })
  .get(async (req, res) => {
    assertProjectsReadScope(req);
    const result = await projectService.listInvites(req.user!, req.query as any, {
      db: {
        projects: projectRepository,
        invites: inviteRepository,
      },
    });

    // Same reason as the sibling document list: the token is a redeemable secret with no consumer
    // on this surface. Recipient addresses the caller did not type are withheld as well.
    return res.json({ ...result, data: await toSharerInviteViews(result.data, req.user!) });
  })
  .post(
    rateLimit(PROJECT_INVITE_RATE_LIMIT),
    outboundActionGate(),
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>>(async (req, res) => {
      assertProjectsWriteScope(req);
      const { id } = req.query as { id: string };
      if (!id || typeof id !== 'string') {
        return res.status(400).json({ message: 'Invalid project ID' });
      }
      // An id that is not an ObjectId names no project, so this route answers the 404 itself
      // rather than letting the lookup cast and raise a CastError.
      if (!isValidObjectId(id)) throw new NotFoundError('Project not found');

      const { expiresAt, ...restBody } = createInviteBodySchema.parse(req.body);

      const { view, link } = await createProjectInvite(
        { user: req.user, ability: req.ability, logger: req.logger },
        id,
        { ...restBody, expiresAt }
      );
      return res.json({ ...view, link });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

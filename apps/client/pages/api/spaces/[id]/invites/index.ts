// GET/POST /api/spaces/:id/invites - pending named invites; invite people by address. Managers only.
import { InviteType } from '@bike4mind/common';
import {
  Group,
  fabFileRepository,
  inviteRepository,
  organizationRepository,
  projectRepository,
  sessionRepository,
  spaceRepository,
} from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { createDocumentInvite, createInviteBodySchema } from '@server/managers/createDocumentInvite';
import { toSharerInviteViews } from '@server/managers/inviteManager';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadManagedSpace } from '@server/spaces/spaceAccess';
import { z } from 'zod';

type Query = { id?: string };

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler<{}, unknown, unknown, Query>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const invites = await sharingService.listInvitesForDocument(
        req.user!,
        { documentId: space.id, type: InviteType.Space },
        {
          db: {
            invites: inviteRepository,
            fabFiles: fabFileRepository,
            sessions: sessionRepository,
            projects: projectRepository,
            organizations: organizationRepository,
            groups: Group,
            spaces: spaceRepository,
          },
        }
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(await toSharerInviteViews(invites, req.user!));
    })
  )
  .post(
    outboundActionGate(),
    asyncHandler<{}, unknown, z.infer<typeof createInviteBodySchema>, Query>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const body = createInviteBodySchema.parse(req.body);
      res.json(await createDocumentInvite(req, { type: InviteType.Space, id: space.id, body }));
    })
  );

export default handler;

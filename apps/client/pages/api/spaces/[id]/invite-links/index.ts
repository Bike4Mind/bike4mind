// GET/POST /api/spaces/:id/invite-links - list and mint Space join links. Managers only.
// A link names nobody and admits whoever holds it as a plain member, capped and expiring.

import { InviteType } from '@bike4mind/common';
import { inviteRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { createDocumentInvite } from '@server/managers/createDocumentInvite';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { loadManagedSpace, toSpaceInviteLinkView } from '@server/spaces/spaceAccess';
import { z } from 'zod';

const MAX_LINK_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  expiresAt: z.coerce
    .date()
    .refine(date => date.getTime() > Date.now(), 'expiresAt must be in the future')
    .refine(date => date.getTime() <= Date.now() + MAX_LINK_LIFETIME_MS, 'expiresAt must be within 90 days'),
  available: z.number().int().min(1).max(sharingService.MAX_ORG_LINK_AVAILABLE).optional(),
  allowedDomains: z
    .array(z.string().trim().toLowerCase().max(253).regex(sharingService.HOSTNAME_PATTERN, 'Invalid domain'))
    .max(sharingService.MAX_INVITE_ALLOWED_DOMAINS)
    .optional(),
});

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireFeatureEnabled('EnableSpaces'))
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string; after?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const cursor = z
        .string()
        .regex(/^[a-f0-9]{24}$/i)
        .optional()
        .safeParse(req.query.after);
      if (!cursor.success) throw new BadRequestError('Invalid invite link cursor');
      const pageSize = 50;
      const invites = await inviteRepository.findPageByDocumentId(space.id, {
        type: InviteType.Space,
        linkOnly: true,
        afterId: cursor.data,
        limit: pageSize + 1,
      });
      const page = invites.slice(0, pageSize);
      if (invites.length > pageSize) res.setHeader('X-Next-Cursor', page[page.length - 1].id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(page.map(toSpaceInviteLinkView));
    })
  )
  .post(
    outboundActionGate(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const space = await loadManagedSpace(req.user!, req.query.id);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
      const { expiresAt, available, allowedDomains } = parsed.data;

      const created = await createDocumentInvite(req, {
        type: InviteType.Space,
        id: space.id,
        body: {
          permissions: [],
          expiresAt,
          available,
          recipients: [],
          link: true,
          ...(allowedDomains?.length ? { allowedDomains } : {}),
        },
      });
      res.status(201).json(created);
    })
  );

export default handler;

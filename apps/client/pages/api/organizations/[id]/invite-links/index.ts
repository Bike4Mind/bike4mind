// GET/POST /api/organizations/:id/invite-links
// List and mint Organization share links: invites that name nobody and admit whoever holds the token,
// each join seat-checked on accept (sharingService.acceptInvite).

import { InviteType, isLinkOnlyInvite, Permission, roleForPermissions } from '@bike4mind/common';
import { inviteRepository } from '@bike4mind/database';
import { sharingService } from '@bike4mind/services';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { createDocumentInvite } from '@server/managers/createDocumentInvite';
import { loadManagedOrganization, toOrgInviteLinkView } from '@server/organizations/orgInviteLinks';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';

const MAX_LINK_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

const bodySchema = z.object({
  permissions: z.array(z.enum(Permission)),
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
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organization = await loadManagedOrganization(req.user!, req.query.id);
      const invites = await inviteRepository.findAllByDocumentId(organization.id);
      const links = invites
        .filter(invite => invite.type === InviteType.Organization && isLinkOnlyInvite(invite))
        .map(toOrgInviteLinkView);
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(links);
    })
  )
  .post(
    outboundActionGate(),
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organization = await loadManagedOrganization(req.user!, req.query.id);
      const parsed = bodySchema.safeParse(req.body);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message || 'Invalid request body');
      const { permissions, expiresAt, available, allowedDomains } = parsed.data;
      if (!roleForPermissions(permissions)) throw new BadRequestError('Invalid role for organization invite');

      const created = await createDocumentInvite(req, {
        type: InviteType.Organization,
        id: organization.id,
        body: {
          permissions,
          expiresAt,
          available,
          recipients: [],
          link: true,
          ...(allowedDomains?.length ? { allowedDomains } : {}),
        },
      });
      const createdId = (created as Record<string, unknown>).id;
      await recordAdminActionFromRequest(req, {
        action: 'org.invite_link.created',
        actorScope: 'organization',
        target: { kind: 'organization', id: organization.id, displayName: organization.name },
        summary: 'created an organization share link',
        details: {
          inviteId: typeof createdId === 'string' ? createdId : null,
          permissions,
          allowedDomainCount: allowedDomains?.length ?? 0,
        },
      });
      res.status(201).json(created);
    })
  );

export default handler;

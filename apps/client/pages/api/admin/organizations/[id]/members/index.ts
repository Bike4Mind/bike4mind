import { z } from 'zod';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  OrganizationEvents,
  UnprocessableEntityError,
  organizationMemberRole,
  organizationSeatUsage,
  organizationSeatsFullMessage,
} from '@bike4mind/common';
import { organizationRepository, userRepository, withTransaction } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { logEventSafe } from '@server/utils/analyticsLog';
import { parseAdminActionReason, recordAdminActionFromRequest, userAuditTarget } from '@server/utils/adminAudit';
import { assertFullAdminForMembership } from '@server/organizations/adminMembership';

const BodySchema = z.object({ userId: z.string().regex(/^[0-9a-f]{24}$/i) });

/** Adds a user to an organization as a member, from the admin user profile. */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'users:moderate' } }).post(async (req, res) => {
  assertFullAdminForMembership(req.user);
  const organizationId = req.query.id;
  if (typeof organizationId !== 'string' || !organizationId) throw new BadRequestError('Organization id required');
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) throw new BadRequestError('Pick a user to add');
  const { userId } = parsed.data;
  const reason = parseAdminActionReason((req.body as { reason?: unknown }).reason);

  const added = await withTransaction(async () => {
    const organization = await organizationRepository.findById(organizationId);
    if (!organization) throw new NotFoundError('Organization not found');
    const role = organizationMemberRole(organization, userId);
    if (role === 'owner') throw new ConflictError(`They already own ${organization.name}.`);
    if (role) throw new ConflictError(`They are already a member of ${organization.name}.`);
    const seats = organizationSeatUsage(organization);
    if (seats.full) {
      throw new UnprocessableEntityError(organizationSeatsFullMessage(organization.name, seats.seats));
    }

    const { user } = await organizationService.addMember(
      req.user,
      { organizationId, userId },
      { db: { organizations: organizationRepository, users: userRepository }, logger: req.logger }
    );
    await recordAdminActionFromRequest(req, {
      action: 'org.member.added',
      target: await userAuditTarget(userId),
      organizationId,
      summary: `added to organization ${organization.name}`,
      reason,
      details: { organizationName: organization.name, role: 'member' },
    });
    return user;
  });

  await logEventSafe(
    {
      userId: req.user.id,
      type: OrganizationEvents.ADD_ORG_MEMBER,
      metadata: { organizationId, memberEmail: added.email || '', memberLevel: added.level },
    },
    { ability: req.ability },
    req.logger,
    organizationId
  );

  return res.status(201).json({ organizationId, userId, role: 'member' });
});

export const config = { api: { externalResolver: true } };
export default handler;

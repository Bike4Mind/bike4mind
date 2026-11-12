import { isOrgOwnerOrCurrentAdmin, orgAclRowConfersMembership, toSafeOrganization } from '@bike4mind/common';
import { Organization, organizationRepository } from '@bike4mind/database/infra';
import { User } from '@bike4mind/database/auth';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { z } from 'zod';
import type { IUserDocument } from '@bike4mind/common';

const bodySchema = z.object({ required: z.boolean(), graceDays: z.number().int().min(0).max(30) }).strict();

async function getManagedOrganization(id: unknown, user: IUserDocument) {
  if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw new BadRequestError('Invalid organization id');
  const organization = await organizationRepository.findById(id);
  if (!organization) throw new NotFoundError('Organization not found');
  if (!isOrgOwnerOrCurrentAdmin(user, organization)) throw new ForbiddenError('Organization admin required');
  if (organization.personal) throw new BadRequestError('MFA policy is only available for teams');
  return organization;
}

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const organization = await getManagedOrganization(req.query.id, req.user!);
      const memberIds = [
        organization.userId,
        ...organization.users.filter(orgAclRowConfersMembership).map(member => member.userId),
      ];
      const members = await User.find(
        { _id: { $in: memberIds }, serviceAccountOrganizationId: null },
        { _id: 1, name: 1, 'mfa.totpEnabled': 1 }
      ).lean();
      return res.json({
        members: members.map(member => ({
          id: String(member._id),
          name: member.name,
          mfaEnabled: member.mfa?.totpEnabled === true,
        })),
      });
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const { required, graceDays } = bodySchema.parse(req.body);
      const organization = await getManagedOrganization(req.query.id, req.user!);
      const mfaPolicy = {
        required,
        graceEndsAt: required ? new Date(Date.now() + graceDays * 86_400_000) : null,
      };
      const updated = await Organization.findByIdAndUpdate(organization.id, { $set: { mfaPolicy } }, { new: true });
      if (!updated) throw new NotFoundError('Organization not found');
      return res.json(toSafeOrganization(updated, { userId: req.user!.id, isAdmin: req.user!.isAdmin }));
    })
  );

export const config = { api: { externalResolver: true } };
export default handler;

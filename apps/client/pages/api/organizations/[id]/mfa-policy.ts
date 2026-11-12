import { z } from 'zod';
import { canAdministerOrganization } from '@bike4mind/common';
import { organizationRepository, userRepository, User, withTransaction } from '@bike4mind/database';
import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { recordOrganizationAuditEvent } from '@bike4mind/server-utils/utils/organizationAudit';
import { NotFoundError } from '@bike4mind/utils';
import { assertOrganizationMfa } from '@bike4mind/server-utils/auth/organizationMfa';

const bodySchema = z.object({ required: z.boolean(), graceDays: z.number().int().min(0).max(30) }).strict();

export default baseApi()
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = z.string().parse(req.query.id);
      const org = await organizationService.get(req.user!, { id }, { db: { organizations: organizationRepository } });
      const canManage = canAdministerOrganization(req.user!, org);
      const members = canManage
        ? await organizationService.getUsers(
            req.user!,
            { id },
            { db: { organizations: organizationRepository, users: userRepository } }
          )
        : [req.user!];
      const users = await User.find(
        { _id: { $in: members.map(member => member.id) } },
        { 'mfa.totpEnabled': 1 }
      ).lean();
      res.json({
        policy: org.mfaPolicy ?? { required: false, graceDays: 7, enforceAfter: null },
        members: users.map(user => ({ userId: String(user._id), enrolled: user.mfa?.totpEnabled === true })),
      });
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = z.string().parse(req.query.id);
      const input = bodySchema.parse(req.body);
      const policy = await withTransaction(async () => {
        const org = await organizationRepository.findById(id);
        if (!org || !canAdministerOrganization(req.user!, org)) throw new NotFoundError('Organization not found');
        await assertOrganizationMfa(req.user!.id, id, org);
        const previous = org.mfaPolicy;
        const unchanged = previous?.required === input.required && previous.graceDays === input.graceDays;
        const policy = {
          ...input,
          enforceAfter: input.required
            ? unchanged
              ? previous!.enforceAfter
              : new Date(Date.now() + input.graceDays * 86_400_000)
            : null,
        };
        if (!unchanged && !(await organizationRepository.update({ id, mfaPolicy: policy }))) {
          throw new NotFoundError('Organization not found');
        }
        if (!unchanged)
          await recordOrganizationAuditEvent({
            organizationId: id,
            actorUserId: req.user!.id,
            action: 'policy.updated',
          });
        return policy;
      });
      res.json({ policy });
    })
  );

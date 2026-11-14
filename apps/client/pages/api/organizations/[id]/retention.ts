import { z } from 'zod';
import { foreverRetention, retentionPolicySchema, canAdministerOrganization } from '@bike4mind/common';
import { verifyOrgAccess, verifyOrgMemberOrManager } from '@bike4mind/server-utils/utils/orgAccess';
import { createRetentionEstimate, saveRetentionPolicy } from '@bike4mind/server-utils/organizations/retentionPolicy';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';

const bodySchema = z
  .object({
    policy: retentionPolicySchema,
    version: z.number().int().nonnegative(),
    confirmationToken: z.string().uuid().optional(),
  })
  .strict();

const organizationIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

const organizationIdOf = (value: unknown): string => {
  const parsed = organizationIdSchema.safeParse(value);
  if (!parsed.success) throw new BadRequestError('Invalid organization id');
  return parsed.data;
};

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = organizationIdOf(req.query.id);
      const org = await verifyOrgMemberOrManager(req.user!, id);
      return res.json({ policy: org.retentionPolicy ?? foreverRetention, version: org.retentionVersion ?? 0 });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = organizationIdOf(req.query.id);
      const org = await verifyOrgAccess(req.user!, id);
      const { policy } = bodySchema.parse(req.body);
      if (org.personal) throw new BadRequestError('Retention requires a team organization');
      return res.json(await createRetentionEstimate(org.id, req.user!.id, org.retentionVersion ?? 0, policy));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = organizationIdOf(req.query.id);
      const org = await verifyOrgAccess(req.user!, id);
      const { policy, version, confirmationToken } = bodySchema.parse(req.body);
      return res.json(
        await saveRetentionPolicy(org.id, req.user!.id, policy, version, confirmationToken, undefined, {
          auditActorUserId: req.user!.impersonatedBy ?? req.user!.id,
          canAdminister: currentOrganization => canAdministerOrganization(req.user!, currentOrganization),
        })
      );
    })
  );

export default handler;
export const config = { api: { externalResolver: true } };

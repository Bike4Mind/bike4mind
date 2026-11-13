import { z } from 'zod';
import { foreverRetention, retentionPolicySchema } from '@bike4mind/common';
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

const handler = baseApi({ auth: 'jwtOnly' })
  .get(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;
      if (typeof id !== 'string') throw new BadRequestError('Invalid organization id');
      const org = await verifyOrgMemberOrManager(req.user!, id);
      return res.json({ policy: org.retentionPolicy ?? foreverRetention, version: org.retentionVersion ?? 0 });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;
      if (typeof id !== 'string') throw new BadRequestError('Invalid organization id');
      const org = await verifyOrgAccess(req.user!, id);
      const { policy } = bodySchema.parse(req.body);
      if (org.personal) throw new BadRequestError('Retention requires a team organization');
      return res.json(await createRetentionEstimate(id, req.user!.id, org.retentionVersion ?? 0, policy));
    })
  )
  .put(
    asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
      const id = req.query.id;
      if (typeof id !== 'string') throw new BadRequestError('Invalid organization id');
      await verifyOrgAccess(req.user!, id);
      const { policy, version, confirmationToken } = bodySchema.parse(req.body);
      return res.json(await saveRetentionPolicy(id, req.user!.id, policy, version, confirmationToken));
    })
  );

export default handler;
export const config = { api: { externalResolver: true } };

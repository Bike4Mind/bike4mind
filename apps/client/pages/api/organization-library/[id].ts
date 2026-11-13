import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { OrganizationLibrary } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { NotFoundError } from '@bike4mind/utils';
import { respond } from '@server/utils/respond';
import { libraryItemResponse } from '@server/organizations/libraryResponse';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = z
      .string()
      .regex(/^[a-f\d]{24}$/i)
      .parse(req.query.id);
    const organizationIds = await organizationRepository.findMembershipOrgIds(req.user.id);
    const item = await OrganizationLibrary.findOne({ _id: id, organizationId: { $in: organizationIds } });
    if (!item) throw new NotFoundError('Library item not found');
    respond(res, libraryItemResponse, { item });
  })
);

export default handler;

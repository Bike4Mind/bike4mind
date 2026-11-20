import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { OrganizationLibrary } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { respond } from '@server/utils/respond';
import { libraryListResponse } from '@server/organizations/libraryResponse';

const handler = baseApi({ auth: 'jwtOnly' }).get(
  asyncHandler<{}, unknown, unknown, { kind?: string }>(async (req, res) => {
    const organizationIds = await organizationRepository.findMembershipOrgIds(req.user.id);
    const kind = z.enum(['agent', 'skill', 'prompt', 'template']).optional().parse(req.query.kind);
    const items = await OrganizationLibrary.find({ organizationId: { $in: organizationIds }, ...(kind && { kind }) })
      .select('-definition')
      .sort({ pinned: -1, name: 1 });
    respond(res, libraryListResponse, { items });
  })
);

export default handler;

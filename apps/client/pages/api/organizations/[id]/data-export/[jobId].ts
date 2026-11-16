import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import {
  organizationExportQuery,
  organizationExportStatus,
  requireOrganizationExportOwner,
} from '@bike4mind/server-utils/utils/organizationDataExport';

const query = organizationExportQuery.extend({ jobId: z.uuid(), download: z.enum(['true', 'false']).optional() });
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const { id: requestedId, jobId, download } = query.parse(req.query);
  const { id } = await requireOrganizationExportOwner(req.user, requestedId);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await organizationExportStatus(id, req.user.id, jobId, download === 'true'));
});

export default handler;

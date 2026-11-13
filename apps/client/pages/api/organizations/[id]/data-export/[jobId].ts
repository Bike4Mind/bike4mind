import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import {
  organizationExportQuery,
  organizationExportStatus,
  requireOrganizationExportOwner,
} from '@bike4mind/server-utils/utils/organizationDataExport';

const query = organizationExportQuery.extend({ jobId: z.uuid() });
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const { id, jobId } = query.parse(req.query);
  await requireOrganizationExportOwner(req.user, id);
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await organizationExportStatus(id, req.user.id, jobId));
});

export default handler;

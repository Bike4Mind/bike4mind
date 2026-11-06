import { z } from 'zod';
import { ADMIN_DATA_EXPORT_DOWNLOADED_ACTION, ApiKeyScope } from '@bike4mind/common';
import { ACCOUNT_DATA_EXPORT_TTL_MS, adminDataExportKey } from '@bike4mind/server-utils/utils/accountDataExport';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { requireStepUp } from '@server/auth/stepUp';
import { findDataExportTarget, readAdminDataExportBuiltAt } from '@server/dataSubject/adminDataExports';
import { adminApi } from '@server/middlewares/adminApi';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const DOWNLOAD_LINK_SECONDS = 5 * 60;

/**
 * A five-minute download link for one admin data subject export. The download is audited before the
 * link is signed, so a download that cannot be recorded never yields the data, and the response is
 * never cached.
 */
const handler = adminApi({
  auth: 'jwtOnly',
  requiredScopes: [ApiKeyScope.ADMIN],
  adminPermissions: { GET: 'users:export' },
}).get(async (req, res) => {
  await requireStepUp(req);
  const jobId = z.uuid().safeParse(req.query.jobId);
  if (!jobId.success) return res.status(400).json({ error: 'Invalid export id' });
  const { user, auditTarget } = await findDataExportTarget(req.user, req.query.userId);

  const storage = getFilesStorage();
  const builtAt = await readAdminDataExportBuiltAt(storage, user.id, jobId.data);
  if (!builtAt) return res.status(404).json({ error: 'This export does not exist or is not ready yet.' });
  if (Date.now() - builtAt.getTime() > ACCOUNT_DATA_EXPORT_TTL_MS) {
    return res.status(410).json({ error: 'This export has expired. Request a new one.' });
  }

  await recordAdminActionFromRequest(req, {
    action: ADMIN_DATA_EXPORT_DOWNLOADED_ACTION,
    target: auditTarget,
    summary: 'downloaded a data subject export',
    details: { exportJobId: jobId.data },
  });

  const filename = `data-subject-export-${user.id}-${builtAt.toISOString().slice(0, 10)}.zip`;
  const url = await storage.getSignedUrl(adminDataExportKey(user.id, jobId.data), 'get', {
    audience: 'browser',
    expiresIn: DOWNLOAD_LINK_SECONDS,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    url,
    filename,
    expiresAt: new Date(builtAt.getTime() + ACCOUNT_DATA_EXPORT_TTL_MS).toISOString(),
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

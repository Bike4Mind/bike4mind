import { z } from 'zod';
import { ForbiddenError } from '@bike4mind/common';
import {
  ACCOUNT_DATA_EXPORT_TTL_MS,
  accountDataExportKey,
  isMissingObjectError,
} from '@bike4mind/server-utils/utils/accountDataExport';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { baseApi } from '@server/middlewares/baseApi';

const DOWNLOAD_LINK_SECONDS = 5 * 60;

/**
 * Hands the caller a short-lived download link for an export they requested. The email links to the
 * app page that calls this, not to storage, because a link signed by the worker would die with its
 * credentials long before the export expires. Owner-only by construction: the key is built from
 * req.user.id, so another user's job id resolves to a missing object.
 */
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  if (req.user.impersonatedBy) {
    throw new ForbiddenError("Cannot download an account's data while impersonating its user.");
  }

  const jobId = z.uuid().safeParse(req.query.jobId);
  if (!jobId.success) {
    return res.status(400).json({ error: 'Invalid export id' });
  }

  const storage = getFilesStorage();
  const key = accountDataExportKey(req.user.id, jobId.data);

  let builtAt: Date | undefined;
  try {
    builtAt = (await storage.getMetadata(key)).lastModified;
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
    return res.status(404).json({ error: 'This export does not exist or is not ready yet.' });
  }

  // The lifecycle rule deletes the object a day or two later; the link is refused from 24h on.
  if (!builtAt || Date.now() - builtAt.getTime() > ACCOUNT_DATA_EXPORT_TTL_MS) {
    return res.status(410).json({ error: 'This export has expired. Request a new one from your settings.' });
  }

  const filename = `account-data-${builtAt.toISOString().slice(0, 10)}.zip`;
  const url = await storage.getSignedUrl(key, 'get', {
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
  api: {
    externalResolver: true,
  },
};

export default handler;

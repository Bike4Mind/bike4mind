/**
 * GET /api/v1/files/{id} - read one file back, with a signed download URL once it is
 * downloadable. Doubles as the upload poll for POST /api/v1/files. Loading and authorization
 * are shared with the SPA-internal GET /api/files/{id} via `loadAccessibleFabFile`; this
 * handler only projects the FabFile onto the published snake_case shape.
 */

import { getFileContract, isImageServeable } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';
import { isValidObjectId } from '@server/utils/objectId';
import { NotFoundError } from '@server/utils/errors';

const handler = nextRouteForContract(getFileContract, {
  // Polling an upload should cost one daily slot, not one per poll. Only safe methods are
  // exempted, and the per-minute burst limit still applies.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(id)) throw new NotFoundError('File not found');

  const fabFile = await loadAccessibleFabFile(req, id);
  // Gated on moderation alone, not `status`: `clean` is only reached once the bytes were scanned,
  // while `status` stays `pending` forever on doors that never presign (see moderationRescueSweep).
  const downloadable = isImageServeable(fabFile) && !!fabFile.fileUrl;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    id: fabFile.id,
    file_name: fabFile.fileName,
    mime_type: fabFile.mimeType,
    file_size: fabFile.fileSize,
    moderation_status: fabFile.moderationStatus ?? null,
    download_url: downloadable ? fabFile.fileUrl! : null,
    download_url_expires_at:
      downloadable && fabFile.fileUrlExpireAt ? new Date(fabFile.fileUrlExpireAt).toISOString() : null,
    created_at: new Date(fabFile.createdAt).toISOString(),
  });
});

export default handler;

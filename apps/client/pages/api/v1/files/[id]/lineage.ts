/**
 * GET /api/v1/files/{id}/lineage - what a generated file was made from and into. The public twin of
 * GET /api/studio/files/[id]/lineage: both build the trail with `buildFileLineage` and read through the same
 * access-checked loaders, so they cannot authorize differently; this handler only maps the published shape.
 */

import { fabFileRepository } from '@bike4mind/database';
import { getFileLineageContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { buildFileLineage } from '@server/files/fileLineage';
import { listFilesByIds } from '@server/files/listFilesByIds';
import { toPublicLineage } from '@server/files/toPublicLineage';
import { loadAccessibleFabFile } from '@bike4mind/server-utils/files/loadAccessibleFabFile';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';

const handler = nextRouteForContract(getFileLineageContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/files/[id]/lineage'),
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(id)) throw new NotFoundError('File not found');

  const root = await loadAccessibleFabFile(req, id);
  const lineage = await buildFileLineage(root, {
    readAccessible: ids => listFilesByIds(req, ids),
    findChildIds: (fileId, page) => fabFileRepository.findDerivedChildIds(fileId, page),
  });

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(toPublicLineage(lineage));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;

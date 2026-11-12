/**
 * GET /api/studio/files/:id/lineage - the trail behind a generated file: its ancestors through `derivedFrom`
 * (bounded; unreadable ones redacted) and the readable files made from it. See server/files/fileLineage.ts.
 *
 * Studio only: a signed-in session (no API key) behind the EnableStudioCreateV2 flag, so there is no public contract.
 */
import type { Request } from 'express';
import { fabFileRepository } from '@bike4mind/database';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { buildFileLineage } from '@server/files/fileLineage';
import { listFilesByIds } from '@server/files/listFilesByIds';
import { loadAccessibleFabFile } from '@server/files/loadAccessibleFabFile';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('createV2'))
  .get(
    perUserRateLimit('GET /api/studio/files/[id]/lineage'),
    async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
      const fileId = req.query.id;
      if (!isValidObjectId(fileId)) return res.status(404).json({ msg: 'File not found' });
      req.logger.updateMetadata({ userId: req.user.id, fileId });

      const root = await loadAccessibleFabFile(req, fileId, { browser: true });
      const lineage = await buildFileLineage(root, {
        readAccessible: ids => listFilesByIds(req, ids, { browser: true }),
        findChildIds: (id, page) => fabFileRepository.findDerivedChildIds(id, page),
      });
      return res.json(lineage);
    }
  );

export const config = { api: { externalResolver: true } };
export default handler;

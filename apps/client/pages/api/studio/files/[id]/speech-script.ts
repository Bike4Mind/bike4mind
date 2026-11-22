/**
 * GET /api/studio/files/:id/speech-script - what a generated voice clip says and when each word is spoken, so the
 * Productions editor can time captions from it. `{ script: null }` for a file that is not a generated speech clip.
 * See server/files/speechScript.ts.
 *
 * Studio only: a signed-in session (no API key) behind the EnableStudioCreateV2 flag, so there is no public contract.
 */
import type { Request } from 'express';
import { generationJobRepository } from '@bike4mind/database';
import { requireStudioFeature } from '@bike4mind/server-utils/middlewares/studioFeatureFlag';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { loadAccessibleFabFile } from '@bike4mind/server-utils/files/loadAccessibleFabFile';
import { baseApi } from '@server/middlewares/baseApi';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { loadSpeechScript } from '@server/files/speechScript';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(requireStudioFeature('createV2'))
  .get(
    perUserRateLimit('GET /api/studio/files/[id]/speech-script'),
    async (req: Request<{}, unknown, unknown, { id: string }>, res) => {
      const fileId = req.query.id;
      if (!isValidObjectId(fileId)) return res.status(404).json({ msg: 'File not found' });
      req.logger.updateMetadata({ userId: req.user.id, fileId });

      const file = await loadAccessibleFabFile(req, fileId, { browser: true });
      const script = await loadSpeechScript(file, jobId => generationJobRepository.findById(jobId));
      return res.json({ script });
    }
  );

export const config = { api: { externalResolver: true } };
export default handler;

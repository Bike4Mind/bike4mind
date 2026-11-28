import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import { UpdateAnnotationRequestSchema } from '@bike4mind/common';
import { HTTPError } from '@bike4mind/server-utils/utils/errors';
import type { Response } from 'express';
import { deleteAnnotation, updateAnnotation } from '@server/services/publish/annotations';

/**
 * /api/publish/annotations/[publicId]/[id] - mutate a single annotation.
 *
 *   PATCH  -> edit body (author only) and/or toggle resolution (author, artifact
 *            owner, or admin)
 *   DELETE -> soft-delete (author, artifact owner, or admin)
 *
 * All mutations require an authenticated caller. Annotations are never
 * hard-deleted so the collection stays an audit trail for the future
 * approval/signature surfaces.
 */

/** Maps a service's typed HTTP error to the legacy `{ error }` body; anything else is a real failure. */
function sendServiceError(res: Response, error: unknown) {
  if (error instanceof HTTPError) return res.status(error.statusCode).json({ error: error.message });
  throw error;
}

const handler = baseApi({ auth: false })
  .use(optionalAuth)
  .patch(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const { publicId, id } = req.query as { publicId?: string; id?: string };
    if (!publicId || !id) return res.status(400).json({ error: 'Missing publicId or id' });

    const parsed = UpdateAnnotationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    try {
      return res.status(200).json(await updateAnnotation({ user: req.user, publicId, id, input: parsed.data }));
    } catch (error) {
      return sendServiceError(res, error);
    }
  })
  .delete(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const { publicId, id } = req.query as { publicId?: string; id?: string };
    if (!publicId || !id) return res.status(400).json({ error: 'Missing publicId or id' });

    try {
      await deleteAnnotation({ user: req.user, publicId, id, logger: req.logger });
      return res.status(204).end();
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import { Annotation, PublishedArtifact } from '@bike4mind/database';
import { UpdateAnnotationRequestSchema } from '@bike4mind/common';
import { toAnnotationDto, type AnnotationLean } from '@server/services/publish';

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

async function isArtifactOwner(publicId: string, userId: string): Promise<boolean> {
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null })
    .select('ownerId')
    .lean<{ ownerId: string } | null>();
  return Boolean(artifact && artifact.ownerId === userId);
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

    const ann = await Annotation.findOne({ _id: id, publicId, deletedAt: null });
    if (!ann) return res.status(404).json({ error: 'Not found' });

    const userId = String(req.user.id);
    const isAdmin = Boolean(req.user.isAdmin);
    const isAuthor = ann.authorId === userId;

    if (parsed.data.body !== undefined) {
      // Editing the text is author-only - it's their words. Admins may resolve or
      // delete (below), but not reword someone else's comment.
      if (!isAuthor) return res.status(403).json({ error: 'Only the author may edit this annotation' });
      ann.body = parsed.data.body;
    }
    if (parsed.data.resolved !== undefined) {
      // Resolving is author, artifact owner, or admin.
      const isOwner = isAuthor || isAdmin || (await isArtifactOwner(publicId, userId));
      if (!isOwner) return res.status(403).json({ error: 'Not authorized to resolve this annotation' });
      if (parsed.data.resolved) {
        ann.resolvedAt = new Date();
        ann.resolvedBy = userId;
      } else {
        ann.resolvedAt = null;
        ann.resolvedBy = null;
      }
    }

    await ann.save();
    return res.status(200).json(toAnnotationDto(ann.toObject() as unknown as AnnotationLean));
  })
  .delete(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });
    const { publicId, id } = req.query as { publicId?: string; id?: string };
    if (!publicId || !id) return res.status(400).json({ error: 'Missing publicId or id' });

    const ann = await Annotation.findOne({ _id: id, publicId, deletedAt: null });
    if (!ann) return res.status(404).json({ error: 'Not found' });

    const userId = String(req.user.id);
    const isAdmin = Boolean(req.user.isAdmin);
    const allowed = ann.authorId === userId || isAdmin || (await isArtifactOwner(publicId, userId));
    if (!allowed) return res.status(403).json({ error: 'Not authorized to delete this annotation' });

    await ann.softDelete(userId);
    req.logger.info(`[ANNOTATE] delete publicId=${publicId} id=${id} by=${userId}`);
    return res.status(204).end();
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } },
};

export default handler;

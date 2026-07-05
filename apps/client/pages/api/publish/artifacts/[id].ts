import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import { PublishedArtifact } from '@bike4mind/database';
import { VisibilitySchema, CommentPolicySchema } from '@bike4mind/common';
import { resolveVisibility, invalidatePublishCdn, toCacheTarget } from '@server/services/publish';

/**
 * /api/publish/artifacts/[id] - manage one published artifact by its publicId.
 *   GET    -> full record (owner/admin, or anyone if public)
 *   PATCH  -> update title/description/visibility/commentPolicy (owner/admin)
 *   DELETE -> soft-delete / archive (owner/admin)
 */

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  visibility: VisibilitySchema.optional(),
  commentPolicy: CommentPolicySchema.optional(),
});

function canManage(artifact: { ownerId: string }, user: { id: string; isAdmin?: boolean }): boolean {
  return artifact.ownerId === String(user.id) || !!user.isAdmin;
}

const handler = baseApi()
  .get(async (req, res) => {
    const publicId = String(req.query.id);
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null }).lean<{
      ownerId: string;
      visibility: string;
    } | null>();
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    // Non-public artifacts require an owner/admin viewer on this management route.
    if (artifact.visibility !== 'public') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (!canManage(artifact, req.user)) {
        return res.status(403).json({ error: 'Not authorized to view this artifact' });
      }
    }
    return res.status(200).json({ artifact });
  })
  .patch(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const publicId = String(req.query.id);
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    if (!canManage(artifact, req.user)) {
      return res.status(403).json({ error: 'Not authorized to update this artifact' });
    }
    if (parsed.data.title !== undefined) artifact.title = parsed.data.title;
    if (parsed.data.description !== undefined) artifact.description = parsed.data.description;
    const wasPublic = artifact.visibility === 'public';
    if (parsed.data.visibility !== undefined) {
      // Validate the requested visibility against the artifact's scope-tier policy
      // (same rules as publish) so PATCH can't set a tier-invalid visibility.
      const viz = resolveVisibility(artifact.tier, parsed.data.visibility);
      if (!viz.ok) {
        return res.status(400).json({ error: viz.error, code: viz.code });
      }
      artifact.visibility = parsed.data.visibility;
    }
    if (parsed.data.commentPolicy !== undefined) artifact.commentPolicy = parsed.data.commentPolicy;
    await artifact.save();

    // Downgrading away from public must purge the cached public copy immediately,
    // otherwise the now-restricted page keeps serving from cache.
    // Fire-and-forget - the service is best-effort and swallows its own errors.
    if (wasPublic && artifact.visibility !== 'public') {
      void invalidatePublishCdn(toCacheTarget(artifact), req.logger);
    }
    return res.status(200).json({ artifact: artifact.toJSON() });
  })
  .delete(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const publicId = String(req.query.id);
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    if (!canManage(artifact, req.user)) {
      return res.status(403).json({ error: 'Not authorized to delete this artifact' });
    }
    const wasPublic = artifact.visibility === 'public';
    await artifact.softDelete(String(req.user.id));
    // Purge the CDN so a deleted public page stops serving from cache immediately
    // (fire-and-forget - best-effort, never blocks the delete).
    if (wasPublic) {
      void invalidatePublishCdn(toCacheTarget(artifact), req.logger);
    }
    return res.status(200).json({ ok: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

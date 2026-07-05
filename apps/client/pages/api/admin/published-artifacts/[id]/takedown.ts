import { Request } from 'express';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact, PublishedArtifactReport } from '@bike4mind/database';
import { invalidatePublishCdn, toCacheTarget } from '@server/services/publish';

/**
 * Admin takedown / restore for a public page.
 *   POST   -> take the page down: soft-delete it, mark moderationStatus
 *            'taken_down' with a reason, resolve its open reports, and purge
 *            the CDN so it stops serving immediately.
 *   DELETE -> restore a taken-down page (un-delete, back to 'active') and purge
 *            the CDN so the cached 404 stops serving immediately.
 *
 * State changes use a single atomic findOneAndUpdate (not load-mutate-save) so
 * concurrent admin actions can't clobber each other.
 */

const TakedownSchema = z.object({ reason: z.string().max(1000).optional() });

/** Strip CR/LF from admin-supplied free text before it reaches the log line. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

const handler = baseApi()
  .post(async (req: Request, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }
    const publicId = String(req.query.id);
    const parsed = TakedownSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    // Atomic take-down: soft-delete + moderation flags in one write so two
    // concurrent admins can't race load->mutate->save (last-writer-wins).
    const artifact = await PublishedArtifact.findOneAndUpdate(
      { publicId, deletedAt: null },
      {
        $set: {
          moderationStatus: 'taken_down',
          takedownReason: parsed.data.reason ?? null,
          deletedAt: new Date(),
          deletedBy: String(req.user.id),
        },
      },
      { new: true }
    );
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found or already taken down' });
    }

    // Resolve any open reports against this page as actioned.
    await PublishedArtifactReport.updateMany(
      { publicId, status: 'open' },
      { $set: { status: 'actioned', resolvedBy: String(req.user.id), resolvedAt: new Date() } }
    );

    // Purge the CDN so the removed page stops serving from cache immediately
    // (the short Cache-Control is only the backstop). Fire-and-forget: the
    // service swallows its own errors, so awaiting would only add AWS latency.
    void invalidatePublishCdn(toCacheTarget(artifact), req.logger);

    req.logger.info(
      `[PUBLISH] takedown ${publicId} by admin=${req.user.id} reason="${oneLine(parsed.data.reason ?? '')}"`
    );
    return res.status(200).json({ ok: true });
  })
  .delete(async (req: Request, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }
    const publicId = String(req.query.id);

    // Restore only a previously taken-down page, atomically. Un-deleting clears
    // deletedAt, which re-activates the partial unique index on {tier,scopeId,slug};
    // if the slug was re-published while this page was down, the update collides
    // (E11000); surface that as a 409 rather than a 500.
    let artifact;
    try {
      // reportCount is intentionally NOT reset - it's an audit trail. A restored
      // page therefore re-appears (briefly) near the top of the `status=reported`
      // sort until its reports resolve organically; preferred over erasing history.
      artifact = await PublishedArtifact.findOneAndUpdate(
        { publicId, moderationStatus: 'taken_down' },
        { $set: { moderationStatus: 'active', takedownReason: null, deletedAt: null, deletedBy: null } },
        { new: true }
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        return res.status(409).json({
          error: 'Cannot restore — another page now occupies this URL. The slug was re-published while it was down.',
        });
      }
      throw err;
    }
    if (!artifact) {
      return res.status(404).json({ error: 'No taken-down artifact with that id' });
    }

    // Purge the cached 404 so the restored page is reachable immediately.
    void invalidatePublishCdn(toCacheTarget(artifact), req.logger);

    req.logger.info(`[PUBLISH] restore ${publicId} by admin=${req.user.id}`);
    return res.status(200).json({ ok: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

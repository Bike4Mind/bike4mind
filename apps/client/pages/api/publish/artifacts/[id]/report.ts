import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { PublishedArtifact, PublishedArtifactReport } from '@bike4mind/database';
import { ReportArtifactRequestSchema } from '@bike4mind/common';

/**
 * POST /api/publish/artifacts/[id]/report - flag a public page for abuse.
 *
 * Auth is required so reports carry identity and can be deduped: a unique
 * partial index on (publicId, reporterId, status:'open') means a second report
 * of the same page by the same user is a no-op rather than inflating the count.
 * A successful new report bumps the artifact's `reportCount` and flips a still-
 * `active` page to `reported` so it surfaces in the admin moderation queue.
 *
 * Rate-limited per user (the dedup index only stops re-flagging the SAME page;
 * the limiter stops one account from flooding the queue across MANY pages). The
 * fixed `bucket` keeps it per-route, not per-`[id]`.
 */

const handler = baseApi()
  .use(rateLimit({ limit: 10, windowMs: 60 * 60 * 1000, bucket: 'publish-report' }))
  .post(async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const publicId = String(req.query.id);
    const parsed = ReportArtifactRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }

    // Only public, live pages are reportable - that's the abuse surface this guards.
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null })
      .select('_id visibility')
      .lean<{ _id: unknown; visibility: string } | null>();
    if (!artifact || artifact.visibility !== 'public') {
      return res.status(404).json({ error: 'Public page not found' });
    }

    const reporterId = String(req.user.id);

    // Create the report; the unique partial index makes a repeat flag idempotent.
    try {
      await PublishedArtifactReport.create({
        publicId,
        artifactId: String(artifact._id),
        reporterId,
        reason: parsed.data.reason,
        details: parsed.data.details,
        status: 'open',
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        // Already reported by this user - treat as success, don't double-count.
        return res.status(200).json({ ok: true, alreadyReported: true });
      }
      throw err;
    }

    // Bump the counter and surface the page in the moderation queue in ONE atomic
    // pipeline update (per-document atomic, so concurrent reports can't overshoot
    // the count or race the status flip). The $cond flips anything that isn't a
    // prior admin takedown to 'reported' - crucially this also catches legacy rows
    // published before this field existed (moderationStatus undefined), which an
    // equality filter on 'active' would have silently skipped.
    await PublishedArtifact.updateOne({ publicId, deletedAt: null }, [
      {
        $set: {
          reportCount: { $add: [{ $ifNull: ['$reportCount', 0] }, 1] },
          moderationStatus: {
            $cond: [{ $eq: ['$moderationStatus', 'taken_down'] }, 'taken_down', 'reported'],
          },
        },
      },
    ]);

    req.logger.info(`[PUBLISH] report ${publicId} reason=${parsed.data.reason} reporter=${reporterId}`);
    return res.status(200).json({ ok: true });
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '8kb' } },
};

export default handler;

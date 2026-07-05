import { Request } from 'express';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifactReport } from '@bike4mind/database';

/**
 * GET /api/admin/published-artifacts/[id]/reports - the abuse reports filed
 * against one public page, newest first, so an admin can read the reasons
 * before deciding on a takedown.
 */

const handler = baseApi().get(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }
  const publicId = String(req.query.id);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? 50), 10) || 50));
  const skip = Math.max(0, parseInt(String(req.query.skip ?? 0), 10) || 0);

  const [reports, total] = await Promise.all([
    PublishedArtifactReport.find({ publicId })
      .select('reason details status reporterId resolvedBy resolvedAt createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PublishedArtifactReport.countDocuments({ publicId }),
  ]);

  return res.status(200).json({ reports, total, limit, skip, hasMore: skip + reports.length < total });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

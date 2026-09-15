import { Request } from 'express';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact } from '@bike4mind/database';

/**
 * GET /api/admin/published-artifacts - admin moderation queue.
 *
 * Lists published artifacts for moderation, newest-reported first. Unlike the
 * user-facing list this is admin-only, spans all owners/scopes, includes soft-
 * deleted (taken-down) rows when asked, and is paginated rather than capped.
 *
 * Query params:
 *   status   - 'reported' (default) | 'active' | 'taken_down' | 'all'
 *   limit    - page size (default 50, max 200)
 *   skip     - offset for pagination
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const handler = baseApi().get(async (req: Request, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const status = String(req.query.status ?? 'reported');
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT)
  );
  const skip = Math.max(0, parseInt(String(req.query.skip ?? 0), 10) || 0);

  const filter: Record<string, unknown> = {};
  switch (status) {
    case 'reported':
      filter.moderationStatus = 'reported';
      filter.deletedAt = null;
      break;
    case 'active':
      // Treat legacy rows (published before moderationStatus existed, field
      // absent) as active, so the browse view doesn't silently hide them.
      filter.$or = [{ moderationStatus: 'active' }, { moderationStatus: { $exists: false } }];
      filter.deletedAt = null;
      break;
    case 'taken_down':
      filter.moderationStatus = 'taken_down';
      break;
    case 'all':
      // no constraint - include taken-down (soft-deleted) rows too
      break;
    default:
      return res.status(400).json({ error: `Invalid status filter: ${status}` });
  }

  const [artifacts, total] = await Promise.all([
    PublishedArtifact.find(filter)
      .select(
        'publicId tier scopeId slug title visibility ownerId moderationStatus reportCount takedownReason size source publishedAt deletedAt deletedBy'
      )
      // Reported pages with the most flags first; otherwise most-recent.
      .sort({ reportCount: -1, publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    PublishedArtifact.countDocuments(filter),
  ]);

  return res.status(200).json({ artifacts, total, limit, skip });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

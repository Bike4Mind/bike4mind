import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact, Project } from '@bike4mind/database';
import { buildListVisibilityFilter } from '@server/services/publish';

/**
 * GET /api/publish/artifacts - list artifacts visible to the caller.
 * Non-admins see their own + public + their org/project-visible artifacts
 * (buildListVisibilityFilter); admins see everything. Summary fields only.
 */
const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const userId = String(req.user.id);

  // `?sourceArtifactId=<id>` answers "has the caller already published this notebook
  // artifact?" for the publish dialog's update-existing-vs-new choice. It is
  // inherently owner-scoped (you can only update your own publication) and matches the
  // bundle source linkage written at publish time.
  const sourceArtifactId = typeof req.query.sourceArtifactId === 'string' ? req.query.sourceArtifactId : undefined;

  // `?mine=true` scopes to the caller's OWN artifacts - the set they can manage
  // (PATCH/restore/delete are owner-only). Otherwise apply the visibility filter.
  const mine = req.query.mine === 'true' || req.query.mine === '1';

  const filter: Record<string, unknown> = { deletedAt: null };
  if (sourceArtifactId) {
    filter.ownerId = userId;
    filter['source.artifactId'] = sourceArtifactId;
  } else if (mine) {
    filter.ownerId = userId;
  } else {
    // Default visibility listing is the ONLY branch that consults project visibility, so
    // resolve the caller's accessible project ids here - the owner-scoped branches above
    // never use them, and doing it eagerly cost an extra Project.find on every dialog
    // update-existing lookup (the hot `?sourceArtifactId` path).
    // Membership rows store userId (sharingService pushShareable); path is users.userId, not users.id.
    const projects = await Project.find({ $or: [{ userId }, { 'users.userId': userId }] })
      .select('_id')
      .lean<Array<{ _id: unknown }>>();
    const userProjectIds = projects.map(p => String(p._id));
    const visibilityFilter = buildListVisibilityFilter({
      userId,
      isAdmin: !!req.user.isAdmin,
      userOrganizationId: req.user.organizationId ? String(req.user.organizationId) : null,
      userProjectIds,
    });
    if (visibilityFilter) filter.$and = [visibilityFilter];
  }

  // `versions` can grow unbounded, so compute its length server-side with $size and never
  // ship the array over the wire - the count drives the management tab's version chip and
  // single-version hint. $ifNull guards rows written before the field existed.
  const artifacts = await PublishedArtifact.aggregate([
    { $match: filter },
    { $sort: { publishedAt: -1 } },
    { $limit: 200 },
    {
      $project: {
        publicId: 1,
        tier: 1,
        scopeId: 1,
        slug: 1,
        title: 1,
        description: 1,
        visibility: 1,
        commentPolicy: 1,
        source: 1,
        size: 1,
        publishedAt: 1,
        viewCount: 1,
        ownerId: 1,
        previousVersionMeta: 1,
        versionsCount: { $size: { $ifNull: ['$versions', []] } },
      },
    },
  ]);

  return res.status(200).json({ artifacts });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

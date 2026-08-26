import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact, Project } from '@bike4mind/database';
import { buildListVisibilityFilter, buildListQuery, type ListQueryParams } from '@server/services/publish';

/**
 * GET /api/publish/artifacts - list artifacts visible to the caller.
 * Non-admins see their own + public + their org/project-visible artifacts
 * (buildListVisibilityFilter); admins see everything. Summary fields only.
 *
 * Query params (all optional):
 *   mine, sourceArtifactId  - scoping, as before
 *   q                       - substring match on title + description
 *   kind, visibility, gate, comments, tag - facet filters
 *   sort                    - newest (default) | oldest | views | versions | updated | title
 *   facets                  - 'true' to also compute the facet counts, in a second aggregation.
 *                             OFF by default, and only honoured together with `mine`: they are
 *                             group-bys with no allowDiskUse over the caller's whole scope, the
 *                             existence check the profile screen makes (limit=1) has no use for
 *                             them, and the only caller that wants them is owner-scoped anyway.
 *   limit, skip             - paging. `limit` defaults to LEGACY_LIMIT so callers written
 *                             before paging existed keep their previous behaviour.
 *
 * Always returns `total` alongside the page, which is what lets a caller tell a full page
 * from a truncated list - the previous hard `$limit: 200` with no count meant the
 * management tab silently stopped showing the oldest artifacts past that mark.
 */

/** Matches the pre-paging hard cap, so an existing caller that sends no `limit` is unaffected. */
const LEGACY_LIMIT = 200;
const MAX_LIMIT = 200;

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

  const scope: Record<string, unknown> = { deletedAt: null };
  if (sourceArtifactId) {
    scope.ownerId = userId;
    scope['source.artifactId'] = sourceArtifactId;
  } else if (mine) {
    scope.ownerId = userId;
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
    if (visibilityFilter) scope.$and = [visibilityFilter];
  }

  // Parse then clamp, rather than `parseInt(...) || DEFAULT`: with the falsy-fallback idiom a
  // `limit=0` resolves to the DEFAULT page size instead of the floor, which is the opposite of
  // what the caller asked for.
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.isNaN(rawLimit) ? LEGACY_LIMIT : rawLimit));
  const rawSkip = parseInt(String(req.query.skip ?? ''), 10);
  const skip = Math.max(0, Number.isNaN(rawSkip) ? 0 : rawSkip);

  const params: ListQueryParams = {
    q: typeof req.query.q === 'string' ? req.query.q : undefined,
    kind: typeof req.query.kind === 'string' ? req.query.kind : undefined,
    visibility: typeof req.query.visibility === 'string' ? req.query.visibility : undefined,
    gate: typeof req.query.gate === 'string' ? req.query.gate : undefined,
    comments: typeof req.query.comments === 'string' ? req.query.comments : undefined,
    tag: typeof req.query.tag === 'string' ? req.query.tag : undefined,
    sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
  };
  const { match, sort } = buildListQuery(params);
  const wantFacets = req.query.facets === 'true' || req.query.facets === '1';
  // versionsCount/titleSort must precede $sort ONLY when a sort actually orders by them. For every
  // other sort they are computed inside the rows branch, after $limit, so the $size over versions[]
  // runs on one page rather than the whole scope.
  const sortNeedsDerived = 'versionsCount' in sort || 'titleSort' in sort;
  const derived = {
    versionsCount: { $size: { $ifNull: ['$versions', []] } },
    titleSort: { $toLower: '$title' },
  };

  // AUTHORIZATION clause and caller narrowing merged into ONE leading $match, so an index can
  // serve the whole predicate. Mongo does not use indexes inside a $facet sub-pipeline, so with the
  // narrowing applied in there the { ownerId, tags, deletedAt } index was unreachable for the very
  // filter it was added for.
  //
  // $and rather than a spread: the two objects share no key today, but the collision a spread would
  // one day hide is a narrowing clause clobbering the visibility filter - i.e. WIDENING the
  // authorized set, which buildListQuery says must be impossible. $and makes that structural, and a
  // top-level $and is flattened by the planner so index eligibility is unaffected.
  const filter = Object.keys(match).length ? { $and: [scope, match] } : scope;

  // `versions` can grow unbounded, so compute its length server-side with $size and never
  // ship the array over the wire - the count drives the management tab's version chip and
  // single-version hint. $ifNull guards rows written before the field existed.
  //
  // One aggregation, two answers: the page and the total behind it, both under the same narrowing.
  const [result] = await PublishedArtifact.aggregate([
    { $match: filter },
    // Only when a sort orders by a derived field does it have to exist before $sort (which runs
    // ahead of $project - ordering by a projected-only field silently orders by nothing).
    ...(sortNeedsDerived ? [{ $addFields: derived }] : []),
    {
      $facet: {
        rows: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limit },
          // Cheap placement: after $limit this runs over one page, not the whole scope.
          ...(sortNeedsDerived ? [] : [{ $addFields: derived }]),
          {
            $project: {
              publicId: 1,
              tier: 1,
              scopeId: 1,
              slug: 1,
              title: 1,
              description: 1,
              tags: 1,
              visibility: 1,
              commentPolicy: 1,
              // Needed by the share dialog to seed its "List in search engines" switch. Without
              // it the control renders OFF for an artifact that is genuinely listed, and the
              // owner has no way to turn it off from that dialog.
              discoverable: 1,
              source: 1,
              size: 1,
              publishedAt: 1,
              updatedAt: 1,
              viewCount: 1,
              ownerId: 1,
              previousVersionMeta: 1,
              versionsCount: 1,
              // The gate KIND only - never the hash, which must not leave the server even
              // though this is an aggregate rather than a select:false-honouring find.
              gateKind: '$accessGate.kind',
            },
          },
        ],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  // Facet counts are their OWN aggregation over `scope` alone, deliberately without the caller's
  // narrowing: a chip has to keep showing its count after you click it instead of collapsing to
  // itself. Splitting them out is what lets the rows query above carry its filter in a leading
  // $match; it also makes that property literal rather than a side effect of $facet's isolation.
  //
  // Owner-scoped listings only. Ungated, these are five group-bys with no allowDiskUse over
  // everything an admin can see, and only the management tab (which always sends `mine`) uses them.
  const [facetResult] =
    wantFacets && mine
      ? await PublishedArtifact.aggregate([
          { $match: scope },
          {
            $facet: {
              byKind: [{ $group: { _id: '$source.kind', n: { $sum: 1 } } }],
              byVisibility: [{ $group: { _id: '$visibility', n: { $sum: 1 } } }],
              byGate: [{ $group: { _id: { $ifNull: ['$accessGate.kind', 'none'] }, n: { $sum: 1 } } }],
              withComments: [{ $match: { commentPolicy: { $in: ['open', 'restricted'] } } }, { $count: 'n' }],
              // Sorted by count then name so the row is stable between requests, and capped: a
              // library can carry far more distinct tags than belong in a toolbar, and the full
              // vocabulary is available from GET /api/publish/tags.
              byTag: [
                { $unwind: '$tags' },
                { $group: { _id: '$tags', n: { $sum: 1 } } },
                { $sort: { n: -1, _id: 1 } },
                { $limit: 24 },
              ],
            },
          },
        ])
      : [undefined];

  const buckets = (rows: Array<{ _id: unknown; n: number }> | undefined): Record<string, number> =>
    (rows ?? []).reduce<Record<string, number>>((acc, r) => {
      if (r._id != null) acc[String(r._id)] = r.n;
      return acc;
    }, {});

  return res.status(200).json({
    artifacts: result?.rows ?? [],
    total: result?.total?.[0]?.n ?? 0,
    limit,
    skip,
    facets: {
      kind: buckets(facetResult?.byKind),
      visibility: buckets(facetResult?.byVisibility),
      gate: buckets(facetResult?.byGate),
      comments: facetResult?.withComments?.[0]?.n ?? 0,
      tag: buckets(facetResult?.byTag),
    },
  });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

import bcrypt from 'bcryptjs';
import { normalizePublishTags, type PublishVisibility } from '@bike4mind/common';
import { PublishedArtifact, Project, liveShareTokens } from '@bike4mind/database';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';
import { deletePublishThumbnails } from '@bike4mind/server-utils/utils/publishThumbnails';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  type HTTPError,
} from '@bike4mind/server-utils/utils/errors';
import type { assertOutboundActionAllowed } from '@server/auth/assertOutboundActionAllowed';
// The barrel, not the sibling files: the legacy route tests mock it and must keep covering this code.
import {
  buildListVisibilityFilter,
  buildListQuery,
  excludeNonLiveOwners,
  loadLiveOwner,
  invalidatePublishCdn,
  restrictDuplicatePublications,
  resolveVisibility,
  toCacheTarget,
  validateEmbedOrigins,
  type ListQueryParams,
  type PublishUser,
} from '@server/services/publish';
import { assertPublicationPublicLink } from './organizationPolicy';
import { displayReplyTitle } from './plainTitle';
import { signOwnerThumbnailUrl } from './thumbnailUrl';

/**
 * List, read, update and delete published pages. Transport-free: each function returns the internal
 * document shape (or throws a typed HTTP error carrying `additionalInfo.errorCode`), and each door
 * maps the result and the errors to its own wire format.
 */

type ManageLogger = NonNullable<Parameters<typeof invalidatePublishCdn>[1]>;
type OutboundRequest = Parameters<typeof assertOutboundActionAllowed>[1];
type ManageUser = PublishUser & NonNullable<Parameters<typeof assertOutboundActionAllowed>[0]>;

export type ManagePublishedPageErrorCode =
  | 'authentication_required'
  | 'forbidden'
  | 'not_found'
  | 'invalid_override'
  | 'invalid_domain'
  | 'gate_requires_enforcing_surface'
  | 'embed_origin_invalid'
  | 'embed_origin_self'
  | 'embed_origin_limit'
  | 'embed_requires_open_public';

const MANAGE_ERROR_CODES: ReadonlySet<string> = new Set<ManagePublishedPageErrorCode>([
  'authentication_required',
  'forbidden',
  'not_found',
  'invalid_override',
  'invalid_domain',
  'gate_requires_enforcing_surface',
  'embed_origin_invalid',
  'embed_origin_self',
  'embed_origin_limit',
  'embed_requires_open_public',
]);

/** True for an error thrown by this module; other errors (policy, trust gate) pass through untouched. */
export function isManagePublishedPageError(error: unknown): error is HTTPError {
  if (!(error instanceof Error) || !('statusCode' in error)) return false;
  const code = (error as HTTPError).additionalInfo?.errorCode;
  return typeof code === 'string' && MANAGE_ERROR_CODES.has(code);
}

/** The body the `/api/publish/artifacts` routes have always returned for these errors. */
export function toLegacyErrorBody(error: HTTPError): { error: string; code?: string } {
  const legacyCode = error.additionalInfo?.legacyCode;
  return { error: error.message, ...(typeof legacyCode === 'string' && { code: legacyCode }) };
}

function fail(
  Error_: typeof BadRequestError | typeof ForbiddenError | typeof NotFoundError | typeof UnauthorizedError,
  errorCode: ManagePublishedPageErrorCode,
  message: string,
  legacyCode?: string
): never {
  throw new Error_(message, { errorCode, ...(legacyCode && { legacyCode }) });
}

export function canManage(artifact: { ownerId: string }, user: { id: string; isAdmin?: boolean }): boolean {
  return artifact.ownerId === String(user.id) || !!user.isAdmin;
}

export type PublishedPageRecord = Record<string, unknown>;

// ---------- list ----------

/** Matches the pre-paging hard cap, so a caller that sends no `limit` is unaffected. */
export const LIST_DEFAULT_LIMIT = 200;
export const LIST_MAX_LIMIT = 200;

export interface ListPublishedPagesInput extends ListQueryParams {
  user: PublishUser;
  mine?: boolean;
  sourceArtifactId?: string;
  sourceMessageId?: string;
  facets?: boolean;
  limit?: number;
  skip?: number;
}

export interface ListPublishedPagesResult {
  items: PublishedPageRecord[];
  total: number;
  limit: number;
  skip: number;
  /** Skip value of the next page, or null on the last one. */
  nextSkip: number | null;
  facets: {
    kind: Record<string, number>;
    visibility: Record<string, number>;
    gate: Record<string, number>;
    comments: number;
    tag: Record<string, number>;
  };
}

// Other owners' rows keep only these display fields; a field added to the projection stays
// owner/admin-only unless listed here.
const NON_OWNER_VISIBLE_FIELDS = [
  '_id',
  'publicId',
  'tier',
  'slug',
  'title',
  'description',
  'tags',
  'visibility',
  'commentPolicy',
  'discoverable',
  'size',
  'publishedAt',
  'updatedAt',
  'viewCount',
  'versionsCount',
] as const;

export async function listPublishedPages(input: ListPublishedPagesInput): Promise<ListPublishedPagesResult> {
  const { user, sourceArtifactId, sourceMessageId, mine = false, facets: wantFacets = false } = input;
  const userId = String(user.id);
  const isAdmin = !!user.isAdmin;

  const scope: Record<string, unknown> = { deletedAt: null };
  if (sourceArtifactId) {
    scope.ownerId = userId;
    scope['source.artifactId'] = sourceArtifactId;
  } else if (sourceMessageId) {
    scope.ownerId = userId;
    scope['source.kind'] = 'reply';
    scope['source.messageId'] = sourceMessageId;
  } else if (mine) {
    scope.ownerId = userId;
  } else {
    // Only the default visibility listing consults project visibility; membership rows store
    // userId (path is users.userId, not users.id).
    const projects = await Project.find({ $or: [{ userId }, { 'users.userId': userId }] })
      .select('_id')
      .lean<Array<{ _id: unknown }>>();
    const visibilityFilter = buildListVisibilityFilter({
      userId,
      isAdmin,
      userOrganizationId: user.organizationId ? String(user.organizationId) : null,
      userProjectIds: projects.map(p => String(p._id)),
    });
    if (visibilityFilter) scope.$and = [visibilityFilter];
  }

  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, input.limit ?? LIST_DEFAULT_LIMIT));
  const skip = Math.max(0, input.skip ?? 0);

  const { match, sort } = buildListQuery({
    q: input.q,
    kind: input.kind,
    visibility: input.visibility,
    gate: input.gate,
    comments: input.comments,
    tag: input.tag,
    sort: input.sort,
  });
  // versionsCount/titleSort must precede $sort only when a sort orders by them; otherwise they are
  // computed after $limit so the $size runs on one page rather than the whole scope.
  const sortNeedsDerived = 'versionsCount' in sort || 'titleSort' in sort;
  const derived = {
    versionsCount: { $size: { $ifNull: ['$versions', []] } },
    titleSort: { $toLower: '$title' },
  };

  // Reply rows published before deriveTitle stripped inline markdown still store "Recap: *Tides*".
  // The list shows them as the share page does (displayReplyTitle), which needs the reply body, so
  // ship it only for reply rows whose title holds a marker character. `q` and the title sort still
  // run on the stored value.
  const replyTitleBody = {
    $cond: [
      {
        $and: [
          { $eq: ['$source.kind', 'reply'] },
          { $regexMatch: { input: { $ifNull: ['$title', ''] }, regex: '[*_~`\\[]' } },
        ],
      },
      '$renderedBody',
      '$$REMOVE',
    ],
  };

  // Authorization and caller narrowing share ONE leading $match so an index can serve it (Mongo does
  // not use indexes inside $facet). $and, never a spread: a narrowing key clobbering the visibility
  // clause would widen the authorized set.
  const narrowed = Object.keys(match).length ? { $and: [scope, match] } : scope;
  // Browse listing only; applied before paging so total, skip and limit count the rows the page shows.
  const browse = !sourceArtifactId && !sourceMessageId && !mine;
  const ownerGate = browse && !isAdmin ? await excludeNonLiveOwners(narrowed, userId) : null;
  const filter = ownerGate ? { $and: [narrowed, ownerGate] } : narrowed;

  const [result] = await PublishedArtifact.aggregate([
    { $match: filter },
    ...(sortNeedsDerived ? [{ $addFields: derived }] : []),
    {
      $facet: {
        rows: [
          { $sort: sort },
          { $skip: skip },
          { $limit: limit },
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
              // Seeds the share dialog's "List in search engines" switch.
              discoverable: 1,
              source: 1,
              size: 1,
              publishedAt: 1,
              updatedAt: 1,
              viewCount: 1,
              ownerId: 1,
              previousVersionMeta: 1,
              versionsCount: 1,
              // The gate KIND only: the hash must not leave the server even via an aggregate.
              gateKind: '$accessGate.kind',
              // Consumed and dropped below.
              replyTitleBody,
              thumbnailKey: '$thumbnail.key',
            },
          },
        ],
        total: [{ $count: 'n' }],
      },
    },
  ]);

  // Facet counts are their own aggregation over `scope` alone, without the caller's narrowing, so a
  // chip keeps its count after you click it. Owner-scoped listings only: they are group-bys with no
  // allowDiskUse over everything an admin can see.
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
              // Capped: the full vocabulary is available from GET /api/publish/tags.
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

  const rows = await Promise.all(
    ((result?.rows ?? []) as Array<Record<string, unknown>>).map(
      async ({ replyTitleBody: body, thumbnailKey, ...row }) => {
        const titled =
          typeof body === 'string' && typeof row.title === 'string'
            ? { ...row, title: displayReplyTitle(row.title, body) || row.title }
            : row;
        // Thumbnails are owner-only: signed for the caller's own rows on `mine`, nowhere else.
        if (!mine || row.ownerId !== userId || typeof row.publicId !== 'string' || typeof thumbnailKey !== 'string') {
          return titled;
        }
        const thumbnailUrl = await signOwnerThumbnailUrl(row.publicId, thumbnailKey);
        return thumbnailUrl ? { ...titled, thumbnailUrl } : titled;
      }
    )
  );
  const items = isAdmin
    ? rows
    : rows.map(row => {
        if (row.ownerId === userId) return row;
        const trimmed: PublishedPageRecord = {};
        for (const field of NON_OWNER_VISIBLE_FIELDS) {
          if (field in row) trimmed[field] = row[field];
        }
        return trimmed;
      });

  const total: number = result?.total?.[0]?.n ?? 0;
  return {
    items,
    total,
    limit,
    skip,
    nextSkip: skip + limit < total ? skip + limit : null,
    facets: {
      kind: buckets(facetResult?.byKind),
      visibility: buckets(facetResult?.byVisibility),
      gate: buckets(facetResult?.byGate),
      comments: facetResult?.withComments?.[0]?.n ?? 0,
      tag: buckets(facetResult?.byTag),
    },
  };
}

// ---------- get ----------

export interface GetPublishedPageInput {
  /** Absent for an anonymous viewer of a public page. */
  user?: PublishUser;
  publicId: string;
}

export interface GetPublishedPageResult {
  /**
   * For a manager, the management document (secrets and content snapshots removed). For any other
   * viewer, the same stripped document: the door must narrow it to its public display fields.
   */
  artifact: PublishedPageRecord;
  isManager: boolean;
}

export async function getPublishedPage(input: GetPublishedPageInput): Promise<GetPublishedPageResult> {
  const { user, publicId } = input;
  // .lean() bypasses the schema's toJSON strip, so the share-token capability, the thumbnail record
  // (owner-only, signed link on the owner list) and content snapshots are projected out here.
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null })
    .select('-shareTokens.token -thumbnail -accessGate.passphraseHash -citables -renderedBody')
    .lean<(PublishedPageRecord & { ownerId: string; visibility: string }) | null>();
  if (!artifact) fail(NotFoundError, 'not_found', 'Artifact not found');
  const isManager = !!user && canManage(artifact, user);
  if (artifact.visibility !== 'public') {
    if (!user) fail(UnauthorizedError, 'authentication_required', 'Authentication required');
    if (!isManager) fail(ForbiddenError, 'forbidden', 'Not authorized to view this artifact');
  }
  // A gated public page must not leak display metadata to a non-manager who knows the id: the same
  // 404 as a private page. The same plain 404 for a deleted, banned or suspended owner.
  if (artifact.visibility === 'public' && artifact.accessGate && !isManager) {
    fail(NotFoundError, 'not_found', 'Artifact not found');
  }
  if (!isManager && !(await loadLiveOwner(artifact.ownerId))) {
    fail(NotFoundError, 'not_found', 'Artifact not found');
  }
  if (!isManager) return { artifact, isManager };
  const managed = { ...artifact };
  delete managed.citables;
  delete managed.renderedBody;
  if (managed.accessGate && typeof managed.accessGate === 'object') {
    const gate = { ...managed.accessGate } as Record<string, unknown>;
    delete gate.passphraseHash;
    managed.accessGate = gate;
  }
  return { artifact: managed, isManager };
}

// ---------- update ----------

export type PublishedPageAccessGatePatch =
  { kind: 'passphrase'; passphrase: string } | { kind: 'domain'; allowedDomains: string[] } | null;

export interface PublishedPagePatch {
  title?: string;
  description?: string;
  /** Full replace: `[]` clears every tag. */
  tags?: string[];
  visibility?: PublishVisibility;
  commentPolicy?: 'none' | 'open' | 'restricted';
  discoverable?: boolean;
  /** `null` clears the gate. */
  accessGate?: PublishedPageAccessGatePatch;
  /** Raw strings, normalized and validated here. `[]` clears the allowlist. */
  embedOrigins?: string[];
}

export interface UpdatePublishedPageInput {
  user: ManageUser;
  logger: ManageLogger;
  publicId: string;
  patch: PublishedPagePatch;
  /** The request the user came from, so the trust gate can share its subscription read. */
  request?: OutboundRequest;
}

export async function updatePublishedPage(input: UpdatePublishedPageInput): Promise<PublishedPageRecord> {
  const { user, logger, publicId, patch, request } = input;
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
  if (!artifact) fail(NotFoundError, 'not_found', 'Artifact not found');
  if (!canManage(artifact, user)) fail(ForbiddenError, 'forbidden', 'Not authorized to update this artifact');

  // Both are rendered into the cached share page (header, title, link preview, markdown export).
  const displayChanged =
    (patch.title !== undefined && patch.title !== artifact.title) ||
    (patch.description !== undefined && patch.description !== (artifact.description ?? ''));
  if (patch.title !== undefined) artifact.title = patch.title;
  if (patch.description !== undefined) artifact.description = patch.description;
  // Normalized at the write site so one label cannot end up stored two ways across write paths.
  if (patch.tags !== undefined) artifact.tags = normalizePublishTags(patch.tags);
  // "Open public" = cacheable, anonymous, ungated: adding a gate to a public artifact leaves
  // `visibility` alone but must still purge the CDN, so the gate is part of the comparison.
  const wasPublic = artifact.visibility === 'public';
  const wasOpenPublic = wasPublic && !artifact.accessGate;
  const gateKindBefore = artifact.accessGate?.kind ?? null;
  const domainsBefore = artifact.accessGate?.kind === 'domain' ? [...(artifact.accessGate.allowedDomains ?? [])] : [];
  const embedOriginsBefore = [...(artifact.embedOrigins ?? [])];
  if (patch.visibility !== undefined) {
    // Same scope-tier policy as publish, so PATCH can't set a tier-invalid visibility.
    const viz = resolveVisibility(artifact.tier, patch.visibility);
    if (!viz.ok) fail(BadRequestError, 'invalid_override', viz.error, viz.code);
    artifact.visibility = patch.visibility;
    if (artifact.visibility === 'public') await assertPublicationPublicLink(artifact);
  }
  if (patch.accessGate !== undefined) {
    if (patch.accessGate === null) {
      artifact.accessGate = null;
    } else if (patch.accessGate.kind === 'passphrase') {
      artifact.accessGate = {
        kind: 'passphrase',
        passphraseHash: await bcrypt.hash(patch.accessGate.passphrase, 10),
      };
    } else {
      // Each entry must be a real registrable domain (rejects a bare suffix like co.uk), but is
      // STORED AS ENTERED: reducing `acme.onmicrosoft.com` to `onmicrosoft.com` would admit every
      // other tenant. Matching is exact-or-subdomain against the stored entry.
      const entries = patch.accessGate.allowedDomains.map(d => d.trim().toLowerCase());
      if (entries.some(d => registrableDomain(d, { allowPrivateDomains: true }) === null)) {
        fail(
          BadRequestError,
          'invalid_domain',
          'Each allowed domain must be a registrable domain (e.g. acme.com or a specific subdomain), not a public suffix like co.uk',
          'INVALID_DOMAIN'
        );
      }
      artifact.accessGate = { kind: 'domain', allowedDomains: [...new Set(entries)] };
    }
  }
  // A gate is only meaningful where something enforces it: `visibility: 'public'`, or a live share
  // link (checkShareGrant applies the same gate at any visibility). A private artifact with no live
  // link would never apply it, so fail loud. Scoped to requests that touch the gate or visibility so
  // a stored inconsistency does not hold a title rename hostage. liveShareTokens reads the array and
  // folds in a pre-backfill scalar-only link.
  const touchesGateSurface = patch.accessGate !== undefined || patch.visibility !== undefined;
  if (
    touchesGateSurface &&
    artifact.accessGate &&
    artifact.visibility !== 'public' &&
    liveShareTokens(artifact).length === 0
  ) {
    fail(
      BadRequestError,
      'gate_requires_enforcing_surface',
      'An access gate requires visibility "public" or an active share link - clear the gate, set visibility to public, or create a share link first',
      'GATE_REQUIRES_ENFORCING_SURFACE'
    );
  }
  // The serve route renders the comment widget only for a policy other than 'none' (absent === 'none').
  const commentPolicyChanged =
    patch.commentPolicy !== undefined && patch.commentPolicy !== (artifact.commentPolicy ?? 'none');
  if (patch.commentPolicy !== undefined) artifact.commentPolicy = patch.commentPolicy;
  const discoverableBefore = !!artifact.discoverable;
  if (patch.discoverable !== undefined) artifact.discoverable = patch.discoverable;

  // Embed origins are validated against the FINAL open-public state, so a gate plus an embed grant
  // in one PATCH is rejected as a pair rather than by apply order.
  const isOpenPublicNow = artifact.visibility === 'public' && !artifact.accessGate;

  // `discoverable` is inert outside open-public, and widening again later would silently re-arm
  // indexing nobody chose in that context, so leaving open-public clears it.
  if (!isOpenPublicNow && artifact.discoverable) artifact.discoverable = false;

  // Compared against the pre-PATCH value so an implicit de-arm counts: the flag changes the cached
  // X-Robots-Tag header and the robots <meta>.
  const discoverableChanged = !!artifact.discoverable !== discoverableBefore;
  let embedOriginsChanged = false;
  if (patch.embedOrigins !== undefined) {
    const check = validateEmbedOrigins(patch.embedOrigins, { isOpenPublic: isOpenPublicNow });
    if (!check.ok)
      fail(BadRequestError, check.code.toLowerCase() as ManagePublishedPageErrorCode, check.error, check.code);
    const before = [...(artifact.embedOrigins ?? [])].sort();
    const after = [...check.value].sort();
    embedOriginsChanged = before.join('\n') !== after.join('\n');
    // Absent when empty so the field stays off the document.
    artifact.embedOrigins = check.value.length > 0 ? check.value : undefined;
  }
  // Checked on the resulting state so a restricted owner can narrow a page but not widen it. A gate
  // change counts wherever the gate is still served: public, or via a live share link. Any
  // gate-kind change counts as loosening, even domain to passphrase, to stay conservative.
  const gateKindAfter = artifact.accessGate?.kind ?? null;
  const gateLoosened =
    patch.accessGate !== undefined &&
    gateKindBefore !== null &&
    (artifact.visibility === 'public' || liveShareTokens(artifact).length > 0) &&
    (gateKindAfter !== gateKindBefore ||
      (gateKindAfter === 'domain' &&
        (artifact.accessGate?.allowedDomains ?? []).some(domain => !domainsBefore.includes(domain))));
  const widensExposure =
    (artifact.visibility === 'public' && !wasPublic) ||
    gateLoosened ||
    (!!artifact.discoverable && !discoverableBefore) ||
    (artifact.embedOrigins ?? []).some(origin => !embedOriginsBefore.includes(origin));
  if (widensExposure) {
    // Loaded on demand: the trust gate's import chain (subscriptions, api keys) is only needed on a widening edit.
    const { assertOutboundActionAllowed: assertAllowed } = await import('@server/auth/assertOutboundActionAllowed');
    await assertAllowed(user, request);
  }
  await artifact.save();

  // Any change to the CACHED public response must purge the CDN or the stale copy serves until its
  // TTL: (a) leaving open-public, (b) the embed allowlist (frame-ancestors CSP) while open-public,
  // (c) discoverability (robots header and meta), (d) title or description, (e) comment policy (the
  // widget is cached markup). Awaited: a Lambda can freeze before a dangling promise sends.
  if (
    (wasOpenPublic && !isOpenPublicNow) ||
    (isOpenPublicNow && (embedOriginsChanged || discoverableChanged || displayChanged || commentPolicyChanged))
  ) {
    await invalidatePublishCdn(toCacheTarget(artifact), logger);
  }
  // A copy published before one-record-per-owner+source may still be serving; a downgrade must
  // reach it too (restrictDuplicatePublications only narrows).
  if (patch.visibility !== undefined) {
    await restrictDuplicatePublications(artifact, logger);
  }
  const json = artifact.toJSON() as PublishedPageRecord & {
    accessGate?: { passphraseHash?: string | null } | null;
  };
  // Defense in depth: the hash is select:false, but this doc was loaded in the write path.
  if (json.accessGate && 'passphraseHash' in json.accessGate) delete json.accessGate.passphraseHash;
  // The stored thumbnail record never leaves the server.
  delete json.thumbnail;
  return json;
}

// ---------- delete ----------

export interface DeletePublishedPageInput {
  user: PublishUser;
  logger: ManageLogger;
  publicId: string;
}

export async function deletePublishedPage(input: DeletePublishedPageInput): Promise<void> {
  const { user, logger, publicId } = input;
  const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
  if (!artifact) fail(NotFoundError, 'not_found', 'Artifact not found');
  if (!canManage(artifact, user)) fail(ForbiddenError, 'forbidden', 'Not authorized to delete this artifact');
  const wasPublic = artifact.visibility === 'public';
  await artifact.softDelete(String(user.id));
  // Best-effort and never blocks the delete: a deleted public page must stop serving from cache.
  if (wasPublic) void invalidatePublishCdn(toCacheTarget(artifact), logger);
  // softDelete dropped the owner-only thumbnail record; drop its objects too. Never throws.
  await deletePublishThumbnails([publicId], logger);
}

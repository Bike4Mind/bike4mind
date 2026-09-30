import mongoose, { Schema, model, Document, Model, Types } from 'mongoose';
import type { PublishedArtifact as PublishedArtifactData } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

/**
 * PublishedArtifact - B4M's instantiation of the `artifact-publishing` blueprint.
 * One record backs all three share surfaces (bundle / reply / fabfile) via the
 * `source` discriminator. Primary key is the compound triple { tier, scopeId, slug },
 * unique among non-deleted rows; `publicId` is the short id used in `/p/...` URLs.
 *
 * Mongoose's default `id` virtual (hex of `_id`) satisfies IMongoDocument, so no
 * custom `id` field is needed. Indexes are declared via schema.index() per the
 * repo's MongoDB Index Guidelines (no `index: true` on fields).
 */
/**
 * Optional access gate layered ON TOP of `visibility: 'public'` (issue #383).
 * Orthogonal to the visibility ladder so the shared `PublishVisibility` type
 * (in @bike4mind/common) stays untouched:
 *  - passphrase -> anyone with the link who presents the passphrase
 *  - domain     -> logged-in viewers whose VERIFIED email domain is allowlisted
 * Declared host-side only for now; lift into the common contract in a follow-up.
 */
export interface PublishedArtifactAccessGate {
  kind: 'passphrase' | 'domain';
  /** bcrypt hash; `select: false` in the schema so reads never leak it by default. */
  passphraseHash?: string | null;
  /** Lowercased email-domain allowlist, stored AS ENTERED (never reduced to eTLD+1).
   *  A viewer matches when their verified email host equals an entry or is a subdomain
   *  of it: `acme.com` admits `mail.acme.com`, but `acme.onmicrosoft.com` does NOT
   *  admit `evil.onmicrosoft.com`. Enforced in checkAccessGate. */
  allowedDomains?: string[];
}

export interface IPublishedArtifactDocument extends Omit<PublishedArtifactData, 'createdAt' | 'updatedAt'>, Document {
  id: string; // required by IMongoDocument (Mongoose's Document.id is optional)
  createdAt: Date;
  updatedAt: Date;
  accessGate?: PublishedArtifactAccessGate | null;
  softDelete(deletedBy?: string): Promise<IPublishedArtifactDocument>;
  restore(): Promise<IPublishedArtifactDocument>;
}

const ArtifactFileSubSchema = new Schema(
  {
    path: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    mimeType: { type: String, required: true },
    sha256: { type: String, required: true },
  },
  { _id: false }
);

const SizeSubSchema = new Schema(
  {
    totalBytes: { type: Number, required: true, min: 0, default: 0 },
    fileCount: { type: Number, required: true, min: 0, default: 0 },
  },
  { _id: false }
);

const VersionMetaSubSchema = new Schema(
  {
    publishedAt: { type: Date, required: true },
    publishedBy: { type: String, required: true },
    size: { type: SizeSubSchema, required: true },
    sha256Index: { type: String, required: true },
  },
  { _id: false }
);

const AccessGateSubSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ['passphrase', 'domain'] },
    // Never selected by default: management GET/PATCH responses and the serve
    // route's lean reads must not carry the hash. The passphrase-verify route
    // opts in explicitly with .select('+accessGate.passphraseHash').
    passphraseHash: { type: String, default: null, select: false },
    allowedDomains: { type: [String], default: undefined },
  },
  { _id: false }
);

/**
 * One no-sign-in share link. Keeps its `_id` (unlike the other subschemas here) because the
 * owner UI needs an opaque handle to revoke a single link by - the token itself must never
 * make that round trip, since it is the capability.
 *
 * `viewCount` is per LINK and is deliberately not the artifact's `viewCount`/`externalViewCount`:
 * those count every serve, and `externalViewCount` requires the viewer to be signed in, which a
 * share viewer essentially never is. Bumped by the serve route (#3255 step 2) for any
 * non-crawler view that resolved through that entry, signed in or not - owner-excluded only
 * when the owner is AUTHENTICATED, since an anonymous request carries nothing to tell the
 * owner apart from a stranger.
 */
const ShareTokenSubSchema = new Schema({
  token: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  /** Non-null once revoked; the entry stays so the token cannot be re-minted. */
  revokedAt: { type: Date, default: null },
  viewCount: { type: Number, default: 0, min: 0 },
  lastViewedAt: { type: Date, default: null },
});

const SourceSubSchema = new Schema(
  {
    kind: { type: String, required: true, enum: ['bundle', 'reply', 'fabfile'] },
    artifactId: { type: String },
    sessionId: { type: String },
    messageId: { type: String },
    fabFileId: { type: String },
  },
  { _id: false }
);

const PublishedArtifactSchema = new Schema(
  {
    publicId: { type: String, required: true, unique: true },

    // Compound primary key
    tier: { type: String, required: true, enum: ['user', 'project', 'organization'] },
    scopeId: { type: String, required: true },
    slug: { type: String, required: true },

    title: { type: String, required: true, maxlength: 200 },
    description: { type: String, maxlength: 1000 },
    // Freeform owner labels. Normalized (trimmed/collapsed/lowercased, deduped, capped) by
    // normalizePublishTags at every write site, so the stored form is canonical and the filter
    // can be a plain equality match. No `index: true` here per the repo's index guidelines - the
    // multikey index is declared with the others at the bottom.
    tags: { type: [String], default: [] },

    visibility: {
      type: String,
      enum: ['private', 'project', 'organization', 'public'],
      default: 'private',
    },
    gatedToGroupId: { type: String },

    /** Every share link ever minted for this artifact, revoked ones included (an entry is
     *  retained after revocation so its token can never be re-minted and its view count
     *  survives). Live links are the `revokedAt: null` entries - see `liveShareTokens()`.
     *  Each entry's `_id` is the opaque handle the owner UI revokes by, so unlike the other
     *  subdocuments here this schema keeps its `_id`.
     *
     *  THE single representation of a share link, as of #3523. The `shareToken` /
     *  `shareTokenUpdatedAt` scalars that preceded it were mirrored from the newest live entry
     *  through #3255 step 3 as a rollback escape hatch, and `20260921140000_drop-share-token-scalar`
     *  removed them once no deployed build read them any more. Nothing here may reintroduce a
     *  second copy of this fact: `shareTokenFilter()` and `liveShareTokens()` below are the
     *  only sanctioned readers, and the owner-facing `shareTokenUpdatedAt` response field is
     *  DERIVED from the newest live entry rather than stored. */
    shareTokens: { type: [ShareTokenSubSchema], default: [] },

    /** Optional gate on top of open sharing - see PublishedArtifactAccessGate.
     *  Applies to BOTH share surfaces: `visibility: 'public'` (/p/*) and
     *  share-token links (/a/<token>). */
    accessGate: { type: AccessGateSubSchema, default: null },

    /** Embed allowlist: external https origins permitted to frame this artifact.
     *  Appended to the served `frame-ancestors` CSP. Meaningful ONLY for an open
     *  public artifact (a gated page is no-store and never framed). `undefined`
     *  (not `[]`) when unset so the field is absent rather than an empty array. */
    embedOrigins: { type: [String], default: undefined },

    /** Collaboration gate: who (among viewers) may annotate. Orthogonal to
     *  `visibility` (who may view). Defaults to `none` so existing artifacts
     *  stay read-only until the owner opts in. */
    commentPolicy: {
      type: String,
      enum: ['none', 'open', 'restricted'],
      default: 'none',
    },

    /** Search-engine opt-IN, orthogonal to `visibility` (who may view) the same way
     *  `commentPolicy` is. Default false means EVERY viewer surface is served
     *  `noindex` until the owner explicitly asks to be discoverable, and only ever
     *  takes effect while the artifact is open-public (public AND ungated).
     *  Backfill is deliberately omitted: an absent field reads as falsy, so every
     *  existing row becomes non-indexable on deploy. That is the safe direction -
     *  artifacts published under the old always-indexable behavior opt back IN
     *  rather than staying silently exposed. */
    discoverable: { type: Boolean, default: false },

    ownerId: { type: String, required: true },
    lastPublishedBy: { type: String },

    source: { type: SourceSubSchema, required: true },

    storageKeyPrefix: { type: String, default: '' },
    size: { type: SizeSubSchema, required: true, default: () => ({ totalBytes: 0, fileCount: 0 }) },
    sha256Index: { type: String },
    manifest: { type: [ArtifactFileSubSchema], default: [] },
    declaredApiEndpoints: { type: [String], default: [] },

    /** Body snapshot for reply/fabfile viewer pages (markdown/text). */
    renderedBody: { type: String },
    /** Snapshot of the source reply's citables (reply source only) - see PublishedArtifactSchema
     *  in @bike4mind/common for why this outlives the source Quest. Schemaless (Mixed): citables
     *  carry provider-specific metadata shapes this model has no reason to constrain. */
    citables: { type: [Schema.Types.Mixed], default: undefined },

    publishedAt: { type: Date, default: Date.now },
    previousVersionMeta: { type: VersionMetaSubSchema },
    /** Full version history (oldest -> newest), appended on every publish/revise/
     *  restore. Each entry's bytes are archived at `{storageKeyPrefix}versions/
     *  {sha256Index}.html`. Enables walking across versions + restore-to-any. */
    versions: { type: [VersionMetaSubSchema], default: [] },
    viewCount: { type: Number, default: 0, min: 0 },
    /** Views by anyone OTHER than the signed-in owner (anonymous counts as
     *  external). Feeds the Published gear and social proof; best-effort. */
    externalViewCount: { type: Number, default: 0, min: 0 },

    /** Concurrency lock for AI revise - set while a revision is in flight,
     *  cleared when it finishes (or expires). Prevents two concurrent revisions
     *  from clobbering each other's version. */
    revisingAt: { type: Date, default: null },

    // Moderation
    moderationStatus: {
      type: String,
      enum: ['active', 'reported', 'taken_down'],
      default: 'active',
    },
    reportCount: { type: Number, default: 0, min: 0 },
    takedownReason: { type: String, default: null },

    // Soft-delete markers (default null so the partial unique index applies cleanly)
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'published_artifacts',
    // A share token is an unguessable read capability - strip it from serialized docs so it
    // can never ride along in a full-doc response. Its value is delivered ONLY by the
    // dedicated /share-token endpoint (which reads it via .lean(), bypassing this transform).
    // NOTE: .lean() queries skip this transform, so lean full-doc responses must still
    // exclude it with a projection (see pages/api/publish/artifacts/[id].ts GET).
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, unknown>) => {
        // Strip the capability from each entry but KEEP the rest: the owner UI needs the id
        // (to revoke by), the timestamps and the per-link count, and none of those grant read
        // access on their own. Dropping `shareTokens` wholesale instead would leave that UI
        // with nothing to render.
        if (Array.isArray(ret.shareTokens)) {
          ret.shareTokens = (ret.shareTokens as Record<string, unknown>[]).map(({ token: _token, ...rest }) => rest);
        }
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Indexes (all declared here per MongoDB Index Guidelines)
// Compound primary key, unique among non-deleted rows so a soft-deleted artifact
// does not block re-publishing the same slug.
PublishedArtifactSchema.index(
  { tier: 1, scopeId: 1, slug: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } }
);
// Unguessable share-token lookup for `/a/<shareToken>`. Partial-unique on string-typed
// tokens only: a row with no links has an EMPTY array, so the `shareTokens.token` path does
// not exist on it and it stays out of the index entirely - the same exemption the filter gave
// token-less rows back when this was a scalar. Unique is enforced across documents (a multikey
// index dedupes entries within one document), and covers revoked entries too, which is what
// stops a revoked token from ever being handed out again.
//
// The `{ shareToken: 1 }` index this replaced is dropped by
// `20260921140000_drop-share-token-scalar`; unsetting the field alone would leave the index
// behind, holding its keys against rows that no longer have the path.
PublishedArtifactSchema.index(
  { 'shareTokens.token': 1 },
  { unique: true, partialFilterExpression: { 'shareTokens.token': { $type: 'string' } } }
);
PublishedArtifactSchema.index({ ownerId: 1, deletedAt: 1 }); // a user's published artifacts
PublishedArtifactSchema.index({ visibility: 1, deletedAt: 1 }); // public listing / gate
PublishedArtifactSchema.index({ 'source.kind': 1, 'source.sessionId': 1 }); // reply lookups
PublishedArtifactSchema.index({ 'source.fabFileId': 1 }); // fabfile lookups
// "Is this notebook artifact already published?" drives the publish dialog's
// update-existing-vs-new choice. Scoped by owner so the lookup matches the
// caller's own publication of that artifact.
PublishedArtifactSchema.index({ 'source.artifactId': 1, ownerId: 1, deletedAt: 1 });
PublishedArtifactSchema.index({ publishedAt: -1 }); // recency
PublishedArtifactSchema.index({ moderationStatus: 1, reportCount: -1 }); // admin moderation queue
PublishedArtifactSchema.index({ tier: 1, scopeId: 1, deletedAt: 1 }); // org-scope quota aggregation
// Multikey over tags[] for the management tab's tag filter, which is owner-scoped - hence the
// ownerId prefix. Its rows+total query applies the filter in a LEADING $match for exactly this
// reason; a narrowing inside a $facet sub-pipeline cannot reach an index at all.
// NOT for the tag-vocabulary lookup: that one matches { ownerId, deletedAt } with no tag predicate,
// which { ownerId: 1, deletedAt: 1 } above serves - and serves better, since deletedAt there does
// not sit behind a multikey field.
PublishedArtifactSchema.index({ ownerId: 1, tags: 1, deletedAt: 1 });

PublishedArtifactSchema.virtual('isDeleted').get(function () {
  return this.deletedAt != null;
});

PublishedArtifactSchema.methods.softDelete = function (deletedBy?: string) {
  this.deletedAt = new Date();
  if (deletedBy) this.deletedBy = deletedBy;
  return this.save();
};

PublishedArtifactSchema.methods.restore = function () {
  this.deletedAt = null;
  this.deletedBy = null;
  return this.save();
};

/** One entry of `shareTokens`, as a lean read returns it. */
export interface PublishedArtifactShareToken {
  _id?: Types.ObjectId;
  token?: string;
  createdAt?: Date;
  revokedAt?: Date | null;
  viewCount?: number;
  lastViewedAt?: Date | null;
}

/** The share-link-bearing shape both readers below accept, lean or hydrated. */
export interface ShareTokenBearing {
  shareTokens?: PublishedArtifactShareToken[] | null;
}

/**
 * The query filter that resolves a live artifact by share token.
 *
 * The single definition every share-token reader must use - the serve route, the gate POST
 * handlers and `findByShareToken` below all build their query from here, so the revocation
 * semantics cannot drift between them.
 *
 * The `$elemMatch` is load-bearing: token and `revokedAt: null` must be pinned to the SAME
 * entry, or a revoked link would resolve on the strength of a still-live sibling.
 *
 * Callers still add their own `deletedAt: null`, since this is only the token half.
 *
 * #3523 removed the `$or` against the legacy `shareToken` scalar. It is kept as a function
 * returning a filter object, rather than inlined at the four call sites, for the reason it was
 * introduced: one definition of "this token resolves" is what stops the serve route and the two
 * gate handlers from disagreeing about whether a revoked link still opens.
 */
export function shareTokenFilter(shareToken: string): Record<string, unknown> {
  return { shareTokens: { $elemMatch: { token: shareToken, revokedAt: null } } };
}

/**
 * The live links on an artifact, newest last.
 *
 * Newest LAST is the array's own append order and callers depend on it: the route's single-link
 * response fields all derive from the last element, which is the link the retired scalar used to
 * mirror.
 *
 * #3523 removed the legacy-scalar fold-in. Every live link is now an array entry, which is what
 * lets the route's `ShareLinkView.id` be a plain string rather than nullable.
 */
export function liveShareTokens(artifact: ShareTokenBearing): PublishedArtifactShareToken[] {
  return (artifact.shareTokens ?? []).filter(entry => !!entry?.token && !entry.revokedAt);
}

export const PublishedArtifact =
  (mongoose.models.PublishedArtifact as mongoose.Model<IPublishedArtifactDocument>) ||
  model<IPublishedArtifactDocument>('PublishedArtifact', PublishedArtifactSchema);

export class PublishedArtifactRepository extends BaseRepository<IPublishedArtifactDocument> {
  constructor(model: Model<IPublishedArtifactDocument>) {
    super(model);
  }

  async findByPublicId(publicId: string) {
    return this.findOne({ publicId, deletedAt: null });
  }

  /**
   * Resolve a live artifact by its no-sign-in share token, in either storage shape.
   * The matching rules (and why they are what they are) live on `shareTokenFilter`.
   * Callers needing a lean read build the same filter from it directly.
   */
  async findByShareToken(shareToken: string) {
    if (!shareToken) return null;
    return this.findOne({ deletedAt: null, ...shareTokenFilter(shareToken) });
  }

  /** Look up by the compound key, non-deleted only. */
  async findByKey(tier: string, scopeId: string, slug: string) {
    return this.findOne({ tier, scopeId, slug, deletedAt: null });
  }

  async findActive(filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, deletedAt: null });
  }

  async findByOwner(ownerId: string, filter: Record<string, unknown> = {}) {
    return this.find({ ...filter, ownerId, deletedAt: null });
  }

  async softDeleteByPublicId(publicId: string, deletedBy?: string): Promise<boolean> {
    const query = this.model.findOne({ publicId, deletedAt: null });
    // Only attach an explicit session when one is set; .session(null) overrides
    // transactionAsyncLocalStorage propagation and silently breaks atomicity.
    if (this._txn) {
      query.session(this._txn);
    }
    const doc = await query;
    if (!doc) return false;
    await doc.softDelete(deletedBy);
    return true;
  }
}

export const publishedArtifactRepository = new PublishedArtifactRepository(PublishedArtifact);
export default PublishedArtifact;

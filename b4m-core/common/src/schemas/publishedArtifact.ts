import { z } from 'zod';
import { VisibilitySchema } from './artifacts';
import { CommentPolicySchema } from './annotation';

/**
 * Published-artifact schemas - the B4M instantiation of the `artifact-publishing`
 * blueprint (MillionOnMars/blueprints, extracted from Polaris Publish v1).
 *
 * The blueprint expresses scope/visibility as open string vocabularies; B4M
 * binds them to its own enums:
 *   scope tier  ∈ { user, project, organization }
 *   visibility  ∈ { private, project, organization, public }   (ordered ladder)
 *
 * Unlike Polaris (bundles only), B4M publishes three SOURCE kinds through one
 * record: a rich HTML `bundle`, a chat `reply`, or a `fabfile`. The `source`
 * discriminator records provenance; `bundle` artifacts get the full
 * upload->validate->serve pipeline, while `reply`/`fabfile` are server-rendered
 * viewer pages.
 */

// ─── Scope ──────────────────────────────────────────────────────────────────

export const PublishScopeTierSchema = z.enum(['user', 'project', 'organization']);
export type PublishScopeTier = z.infer<typeof PublishScopeTierSchema>;

/** URL prefix per tier - used to build the public `/p/...` path. */
export const SCOPE_URL_PREFIX: Record<PublishScopeTier, string> = {
  user: '/p/u',
  project: '/p/pj',
  organization: '/p/o',
};

// ─── Visibility (ordered ladder, most- to least-restricted) ───────────────────

export { VisibilitySchema as PublishVisibilitySchema };
export type PublishVisibility = z.infer<typeof VisibilitySchema>;

/** Ordered most-restricted to least-restricted. The serve gate and list filter
 *  reason about "is this rung at least as open as X". */
export const VISIBILITY_ORDER: readonly PublishVisibility[] = ['private', 'project', 'organization', 'public'] as const;

/** Per-tier publish policy: default visibility + the overrides a publisher may pick. */
export const SCOPE_POLICY: Record<
  PublishScopeTier,
  { defaultVisibility: PublishVisibility; allowedOverrides: readonly PublishVisibility[] }
> = {
  user: { defaultVisibility: 'private', allowedOverrides: ['private', 'organization', 'public'] },
  project: { defaultVisibility: 'project', allowedOverrides: ['project', 'organization', 'public'] },
  organization: {
    defaultVisibility: 'organization',
    allowedOverrides: ['organization', 'public'],
  },
};

// ─── Source provenance (B4M-specific) ─────────────────────────────────────────

export const PublishSourceKindSchema = z.enum(['bundle', 'reply', 'fabfile']);
export type PublishSourceKind = z.infer<typeof PublishSourceKindSchema>;

export const PublishSourceSchema = z.object({
  kind: PublishSourceKindSchema,
  /** Set when kind === 'bundle' and the bundle was generated from a B4M artifact. */
  artifactId: z.string().optional(),
  /** Set when kind === 'reply'. */
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  /** Set when kind === 'fabfile'. */
  fabFileId: z.string().optional(),
});
export type PublishSource = z.infer<typeof PublishSourceSchema>;

// ─── Bundle manifest + integrity ──────────────────────────────────────────────

export const ArtifactFileSchema = z.object({
  path: z.string(), // relative to bundle root, e.g. 'index.html', 'assets/style.css'
  size: z.int().nonnegative(),
  mimeType: z.string(),
  sha256: z.string(),
});
export type ArtifactFile = z.infer<typeof ArtifactFileSchema>;

export const ArtifactVersionMetaSchema = z.object({
  publishedAt: z.date(),
  publishedBy: z.string(),
  size: z.object({ totalBytes: z.int().nonnegative(), fileCount: z.int().nonnegative() }),
  sha256Index: z.string(),
});
export type ArtifactVersionMeta = z.infer<typeof ArtifactVersionMetaSchema>;

// ─── Slug rules ────────────────────────────────────────────────────────────────

/** Reserved slugs - must include every tier URL token so a slug can't shadow routing. */
export const RESERVED_SLUGS: readonly string[] = [
  'api',
  'admin',
  'static',
  'p',
  'u',
  'o',
  'pj',
  'r',
  'f',
  'a',
  '_next',
  'health',
];

export const SlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase kebab-case')
  .refine(s => !RESERVED_SLUGS.includes(s), { message: 'slug is reserved' });

// ─── Bundle limits + MIME allowlist (publish-time guardrails) ──────────────────

export const PUBLISH_LIMITS = {
  maxFiles: 50,
  maxBundleBytes: 50 * 1024 * 1024, // 50 MB
  maxFileBytes: 10 * 1024 * 1024, // 10 MB
} as const;

/**
 * Cumulative per-owner publish quotas, distinct from the
 * per-bundle `PUBLISH_LIMITS` above. These cap how much a single user (or a
 * single organization scope) may host in aggregate, bounding both storage cost
 * and the abuse/phishing-hosting surface.
 *
 * Enforcement is aggregate-on-read: at publish time we sum `size.totalBytes`
 * and count active rows for the owner, then compare against these caps. Two
 * concurrent publishes can each read stale usage and both pass, so the true
 * ceiling may be briefly exceeded by roughly one in-flight bundle. That
 * overshoot is acceptable for a cost/abuse guard (it is not a billing
 * boundary); a hard limit would require transactional reservation.
 *
 * `user` caps apply to every artifact a user owns (by `ownerId`), regardless of
 * the scope it was published into. `org` caps apply to artifacts published into
 * an organization scope (`tier: 'organization'`, `scopeId: <orgId>`). A publish
 * into an org scope is checked against BOTH ladders.
 *
 * Values are deliberately generous (a cost/abuse backstop, not a product
 * limit) and are intended to be tunable.
 */
export const PUBLISH_QUOTAS = {
  user: {
    maxArtifacts: 100,
    maxTotalBytes: 500 * 1024 * 1024, // 500 MB
  },
  org: {
    maxArtifacts: 1000,
    maxTotalBytes: 5 * 1024 * 1024 * 1024, // 5 GB
  },
} as const;

export type PublishQuotaScope = keyof typeof PUBLISH_QUOTAS;

export const ALLOWED_MIME_PREFIXES: readonly string[] = ['image/', 'font/', 'audio/', 'video/'];
export const ALLOWED_MIME_EXACT: readonly string[] = [
  'text/html',
  'text/css',
  'text/plain',
  'text/markdown',
  'application/javascript',
  'application/json',
  'application/wasm',
  'application/manifest+json',
  'application/xml',
  'application/octet-stream',
];

// --- Embed allowlist (publisher-controlled external framing) ---

/**
 * Exact external origins a publisher permits to embed this artifact in an iframe
 * (frame-ancestors grants). Publication-level, not version-level: the grant
 * follows the publicId across revisions and restores. Empty/absent means the
 * default posture (app host only). Only meaningful for OPEN-public artifacts
 * (public visibility AND no access gate) - a gated artifact framed cross-origin
 * cannot authenticate, so the serve route restricts emission accordingly.
 */
export const EMBED_ORIGINS_MAX = 5;

/**
 * Parse and normalize one embed origin. Format-only (host-agnostic): the
 * "not under the app or usercontent host" check needs the runtime host and lives
 * server-side. Returns the normalized `https://host[:port]` origin, or null if it
 * is not an exact https origin (no path/query/fragment/userinfo, no wildcard, no
 * IP literal, a real dotted host with a non-numeric TLD).
 */
export function parseEmbedOrigin(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null; // no mixed-content embed grants
  if (url.username || url.password) return null; // no userinfo
  if (url.search || url.hash) return null; // origin only
  if (url.pathname !== '/' && url.pathname !== '') return null; // no path
  const host = url.hostname;
  if (host.includes('*')) return null; // no wildcards
  if (host.startsWith('[')) return null; // no bracketed IPv6
  if (/^\d+(\.\d+){3}$/.test(host)) return null; // no IPv4 literal
  const labels = host.split('.');
  if (labels.length < 2) return null; // must be a real dotted host, not a bare label
  const tld = labels[labels.length - 1];
  if (!/[a-z]/.test(tld)) return null; // TLD must contain a letter (rejects numeric last label)
  // Reconstruct from parsed parts so the returned value is canonical.
  return url.port ? `https://${host}:${url.port}` : `https://${host}`;
}

/** True when `origin`'s host equals `host` or is a subdomain of it. Used server-side
 *  to reject grants that fall under the app or usercontent domain (which would
 *  re-open bundle-on-bundle framing through the "external" path). */
export function isOriginUnderHost(origin: string, host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '');
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return false;
  }
  return originHost === h || originHost.endsWith(`.${h}`);
}

/** Field schema: an array of pre-normalized exact https origins, deduped, capped.
 *  The authoritative host-exclusion check is applied server-side at write time. */
export const EmbedOriginsSchema = z
  .array(z.string())
  .max(EMBED_ORIGINS_MAX)
  .transform(list => [...new Set(list.map(o => o.toLowerCase()))])
  .refine(list => list.every(o => parseEmbedOrigin(o) === o), {
    message: 'each embed origin must be an exact, normalized https origin',
  });

// ─── Moderation (abuse reporting + takedown) ───────────────────────

/**
 * Lifecycle from a moderation standpoint:
 *   active     - published, no open reports
 *   reported   - one or more abuse reports filed; awaiting admin review
 *   taken_down - an admin removed it (also soft-deleted, so it 404s at serve)
 */
export const ModerationStatusSchema = z.enum(['active', 'reported', 'taken_down']);
export type ModerationStatus = z.infer<typeof ModerationStatusSchema>;

/** Why a viewer flagged a public page. */
export const ReportReasonSchema = z.enum(['spam', 'phishing', 'malware', 'abuse', 'copyright', 'other']);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** Open / resolved state of an individual report record. */
export const ReportStatusSchema = z.enum(['open', 'actioned', 'dismissed']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const PublishedArtifactReportSchema = z.object({
  /** The reported artifact's short id (the `/p/...` identifier). */
  publicId: z.string(),
  /** Mongo _id of the reported artifact, denormalized for admin joins. */
  artifactId: z.string(),
  /** Reporter's user id; null for anonymous/unauthenticated reports. */
  reporterId: z.string().nullish(),
  reason: ReportReasonSchema,
  details: z.string().max(2000).optional(),
  status: ReportStatusSchema.prefault('open'),
  /** Admin who actioned/dismissed the report. */
  resolvedBy: z.string().nullish(),
  resolvedAt: z.date().nullish(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type PublishedArtifactReport = z.infer<typeof PublishedArtifactReportSchema>;

/** POST /api/publish/artifacts/:id/report body. */
export const ReportArtifactRequestSchema = z.object({
  reason: ReportReasonSchema,
  details: z.string().max(2000).optional(),
});
export type ReportArtifactRequest = z.infer<typeof ReportArtifactRequestSchema>;

// ─── The published-artifact aggregate ──────────────────────────────────────────

export const PublishedArtifactSchema = z.object({
  /** Short opaque id for short URLs (`/p/r/{publicId}`, `/p/f/{publicId}`) and lookups. */
  publicId: z.string(),

  // Compound primary key: { tier, scopeId, slug }
  tier: PublishScopeTierSchema,
  scopeId: z.string(),
  slug: SlugSchema,

  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),

  visibility: VisibilitySchema.prefault('private'),
  /** Group id a viewer must belong to when gated cross-scope. */
  gatedToGroupId: z.string().optional(),

  /** Unguessable capability token for no-sign-in `/a/<shareToken>` links. Distinct
   *  from `publicId` (which stays stable for `/p/*`) so rotating it revokes every
   *  outstanding link without touching the artifact. Absent until the owner opts in. */
  shareToken: z.string().optional(),
  /** When `shareToken` was last minted/rotated; drives the owner-facing "link created" surface. */
  shareTokenUpdatedAt: z.date().nullish(),

  /** Collaboration gate: who (among viewers) may annotate. Orthogonal to
   *  `visibility`. Defaults to `none` (read-only) until the owner opts in. */
  commentPolicy: CommentPolicySchema.prefault('none'),

  /** Exact external origins permitted to embed this artifact (frame-ancestors
   *  grants). Publication-level; empty/absent means app host only. Uses the same
   *  normalizing/deduping EmbedOriginsSchema as the write path so the stored
   *  contract enforces the canonical-origin invariant, not just `string[]`. */
  embedOrigins: EmbedOriginsSchema.optional(),

  ownerId: z.string(),
  lastPublishedBy: z.string().optional(),

  source: PublishSourceSchema,

  /** Canonical blob prefix '{tier}/{scopeId}/{slug}/'. Empty for non-bundle sources. */
  storageKeyPrefix: z.string(),
  size: z.object({ totalBytes: z.int().nonnegative(), fileCount: z.int().nonnegative() }),
  sha256Index: z.string().optional(),
  manifest: z.array(ArtifactFileSchema).prefault([]),
  declaredApiEndpoints: z.array(z.string()).prefault([]),

  /** Rendered body snapshot for reply/fabfile viewer pages (markdown or text). */
  renderedBody: z.string().optional(),

  publishedAt: z.date(),
  previousVersionMeta: ArtifactVersionMetaSchema.optional(),
  /** Full version history (oldest to newest); each entry's bytes are archived at
   *  `{storageKeyPrefix}versions/{sha256Index}.html`. */
  versions: z.array(ArtifactVersionMetaSchema).prefault([]),
  viewCount: z.int().nonnegative().prefault(0),

  /** Concurrency lock for AI revise (set while a revision is in flight). */
  revisingAt: z.date().nullish(),

  /** Moderation state. */
  moderationStatus: ModerationStatusSchema.prefault('active'),
  reportCount: z.int().nonnegative().prefault(0),
  /** Set when an admin takes the page down (alongside soft-delete). */
  takedownReason: z.string().max(1000).nullish(),

  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullish(),
  deletedBy: z.string().nullish(),
});
export type PublishedArtifact = z.infer<typeof PublishedArtifactSchema>;

// ─── Publish-time validation (the security contract) ───────────────────────────

export const ValidationViolationTypeSchema = z.enum([
  'csp_violation',
  'forbidden_pattern',
  'forbidden_iframe',
  'invalid_asset_url',
  'missing_index',
  'size_exceeded',
  'invalid_mime_type',
  'invalid_path',
]);
export type ValidationViolationType = z.infer<typeof ValidationViolationTypeSchema>;

export const ValidationViolationSchema = z.object({
  type: ValidationViolationTypeSchema,
  message: z.string(),
  file: z.string().optional(),
  line: z.int().optional(),
});
export type ValidationViolation = z.infer<typeof ValidationViolationSchema>;

// ─── API request/response shapes ────────────────────────────────────────────────

const FileDescriptorSchema = z.object({
  path: z.string(),
  size: z.int().nonnegative(),
  mimeType: z.string(),
});

export const UploadUrlRequestSchema = z.object({
  tier: PublishScopeTierSchema,
  scopeId: z.string(),
  slug: SlugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  visibility: VisibilitySchema.optional(),
  gatedToGroupId: z.string().optional(),
  /** Who may annotate the published artifact. Defaults to `none` (read-only). */
  commentPolicy: CommentPolicySchema.optional(),
  /** Origins allowed to embed this artifact (validated + host-excluded server-side). */
  embedOrigins: EmbedOriginsSchema.optional(),
  source: PublishSourceSchema.optional(),
  files: z.array(FileDescriptorSchema).min(1).max(PUBLISH_LIMITS.maxFiles),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequestSchema>;

export const UploadUrlResponseSchema = z.object({
  draftId: z.uuid(),
  uploadUrls: z.array(z.object({ path: z.string(), url: z.string(), expiresAt: z.string() })),
});
export type UploadUrlResponse = z.infer<typeof UploadUrlResponseSchema>;

export const FinalizeRequestSchema = z.object({ draftId: z.uuid() });
export type FinalizeRequest = z.infer<typeof FinalizeRequestSchema>;

/** Publish a chat reply as a viewer page. */
export const PublishReplyRequestSchema = z.object({
  sessionId: z.string(),
  messageId: z.string(),
  title: z.string().min(1).max(200).optional(),
  visibility: VisibilitySchema.optional(),
  tier: PublishScopeTierSchema.prefault('user'),
  scopeId: z.string().optional(),
});
export type PublishReplyRequest = z.infer<typeof PublishReplyRequestSchema>;

/** Publish a FabFile as a viewer page / streamed file. */
export const PublishFabFileRequestSchema = z.object({
  fabFileId: z.string(),
  title: z.string().min(1).max(200).optional(),
  visibility: VisibilitySchema.optional(),
  tier: PublishScopeTierSchema.prefault('user'),
  scopeId: z.string().optional(),
});
export type PublishFabFileRequest = z.infer<typeof PublishFabFileRequestSchema>;

export const PublishResultSchema = z.object({
  publicId: z.string(),
  url: z.string(),
  tier: PublishScopeTierSchema,
  scopeId: z.string(),
  slug: z.string(),
  visibility: VisibilitySchema,
  publishedAt: z.string(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

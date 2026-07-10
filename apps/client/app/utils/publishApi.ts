import { api } from '@client/app/contexts/ApiContext';
import type {
  CommentPolicy,
  PublishResult,
  PublishScopeTier,
  PublishVisibility,
  ReportReason,
  UploadUrlResponse,
} from '@bike4mind/common';
import { SCOPE_URL_PREFIX } from '@bike4mind/common';
import { buildShareFooterHtml } from '@client/app/utils/shareFooter';

/** Summary row for the published-artifacts management list. */
export interface ManagedArtifact {
  publicId: string;
  tier: PublishScopeTier;
  scopeId: string;
  slug: string;
  title: string;
  description?: string;
  visibility: PublishVisibility;
  commentPolicy?: CommentPolicy;
  source: { kind: 'bundle' | 'reply' | 'fabfile'; artifactId?: string };
  size?: { totalBytes: number; fileCount: number };
  viewCount?: number;
  publishedAt?: string;
  previousVersionMeta?: { sha256Index?: string };
  /** Number of entries in the published version history (drives the version switcher
   *  and the single-version hint). 0/1 means no switcher yet; 2+ shows the switcher. */
  versionsCount?: number;
}

/** How a re-publish of an already-published artifact should land. */
export type PublishMode = 'update' | 'new';

/** Build the public `/p/...` path for a published artifact (relative to origin). */
export function toArtifactSharePath(tier: PublishScopeTier, scopeId: string, slug: string): string {
  return `${SCOPE_URL_PREFIX[tier]}/${scopeId}/${slug}`;
}

/** List the caller's OWN published artifacts (the manageable set). */
export async function listMyPublishedArtifacts(): Promise<ManagedArtifact[]> {
  const { data } = await api.get<{ artifacts: ManagedArtifact[] }>('/api/publish/artifacts?mine=true');
  return data.artifacts ?? [];
}

/**
 * Find the caller's existing publication of a given notebook artifact, if any.
 * Returns the most recently published match (the list is sorted newest-first) so the
 * publish dialog can offer "update existing" vs "publish as new". Returns null on no
 * match - callers should treat a lookup failure as "not published" and never block
 * publishing on it.
 */
export async function findPublishedByArtifact(artifactId: string): Promise<ManagedArtifact | null> {
  try {
    const { data } = await api.get<{ artifacts: ManagedArtifact[] }>(
      `/api/publish/artifacts?sourceArtifactId=${encodeURIComponent(artifactId)}`
    );
    return data.artifacts?.[0] ?? null;
  } catch {
    // Best-effort lookup: a transport/auth failure must never block publishing, so
    // degrade to "not published" and let the dialog offer a plain publish-as-new.
    return null;
  }
}

/** Soft-delete (archive) a published artifact (owner/admin). */
export async function deletePublishedArtifact(publicId: string): Promise<void> {
  await api.delete(`/api/publish/artifacts/${publicId}`);
}

/**
 * Explicit share actions default to `public` - the user clicked "Share", so the
 * link should open for the recipient. The share dialog lets them dial it back.
 */
const DEFAULT_SHARE_VISIBILITY: PublishVisibility = 'public';

/** Publish a single assistant reply to a public viewer page (/p/r/{publicId}). */
export async function publishReply(input: {
  sessionId: string;
  messageId: string;
  title?: string;
  visibility?: PublishVisibility;
  /**
   * Scope tier to publish under. Defaults to `'user'` (a personal `/p/r` page). Pass
   * `'organization'` with `scopeId` set to the org id for an org-scoped page the serve gate
   * authorizes to org members - see `replyPublisher`.
   */
  tier?: PublishScopeTier;
  /** Scope id for `tier` (the org id for org tier). Server defaults it to the caller for user tier. */
  scopeId?: string;
}): Promise<PublishResult> {
  const { data } = await api.post<PublishResult>('/api/publish/reply', {
    visibility: DEFAULT_SHARE_VISIBILITY,
    ...input,
  });
  return data;
}

/** Publish a FabFile to a public viewer page (/p/f/{publicId}). */
export async function publishFabFile(input: {
  fabFileId: string;
  title?: string;
  visibility?: PublishVisibility;
  /**
   * Scope tier to publish under. Defaults to `'user'` (a personal `/p/f` page). Pass
   * `'organization'` with `scopeId` set to the org id for an org-scoped page the serve gate
   * authorizes to org members - see `fabFilePublisher`.
   */
  tier?: PublishScopeTier;
  /** Scope id for `tier` (the org id for org tier). Server defaults it to the caller for user tier. */
  scopeId?: string;
}): Promise<PublishResult> {
  const { data } = await api.post<PublishResult>('/api/publish/fabfile', {
    visibility: DEFAULT_SHARE_VISIBILITY,
    ...input,
  });
  return data;
}

/**
 * Map a share-dialog visibility pick to the scope-tier fields the publish endpoints expect.
 * Org visibility publishes a real org-tier page (scopeId = org id) so same-org members can view
 * it - the ONLY combination the serve gate authorizes to org members (a user-tier record's
 * scopeId is the user id, never the viewer's org id, so org visibility on it 403s everyone but
 * the owner). Requires an active org; the dialog only offers the Team option when one exists, so
 * this branch is unreachable without orgId. The server re-validates org membership before
 * trusting the scope. Mirrors `artifactBundlePublisher`.
 */
function orgTierFields(
  visibility: PublishVisibility,
  orgId?: string
): { tier: PublishScopeTier; scopeId: string } | Record<string, never> {
  return visibility === 'organization' && orgId ? { tier: 'organization', scopeId: orgId } : {};
}

/**
 * Build the share-dialog publish callback for a chat reply. When the caller is in an org ("Team")
 * account context, `orgId` lets a Team pick publish an org-scoped page. See `orgTierFields`.
 */
export function replyPublisher(input: {
  sessionId: string;
  messageId: string;
  title?: string;
  /** The caller's active org, when in a "Team" account context. Undefined for personal scope. */
  orgId?: string;
}): (visibility: PublishVisibility) => Promise<PublishResult> {
  const { orgId, ...reply } = input;
  return visibility => publishReply({ ...reply, visibility, ...orgTierFields(visibility, orgId) });
}

/**
 * Build the share-dialog publish callback for a FabFile. When the caller is in an org ("Team")
 * account context, `orgId` lets a Team pick publish an org-scoped page. See `orgTierFields`.
 */
export function fabFilePublisher(input: {
  fabFileId: string;
  title?: string;
  /** The caller's active org, when in a "Team" account context. Undefined for personal scope. */
  orgId?: string;
}): (visibility: PublishVisibility) => Promise<PublishResult> {
  const { orgId, ...file } = input;
  return visibility => publishFabFile({ ...file, visibility, ...orgTierFields(visibility, orgId) });
}

/** Report a public page for abuse. Requires an authenticated caller. */
export async function reportPublishedArtifact(
  publicId: string,
  input: { reason: ReportReason; details?: string }
): Promise<{ ok: boolean; alreadyReported?: boolean }> {
  const { data } = await api.post<{ ok: boolean; alreadyReported?: boolean }>(
    `/api/publish/artifacts/${publicId}/report`,
    input
  );
  return data;
}

/** Change a published item's visibility (owner/admin). */
export async function updatePublishedVisibility(publicId: string, visibility: PublishVisibility): Promise<void> {
  await api.patch(`/api/publish/artifacts/${publicId}`, { visibility });
}

/** Change who may comment on a published item (owner/admin). */
export async function updatePublishedCommentPolicy(publicId: string, commentPolicy: CommentPolicy): Promise<void> {
  await api.patch(`/api/publish/artifacts/${publicId}`, { commentPolicy });
}

/**
 * Restore a published bundle to its immediately-previous version (owner/admin).
 * Returns the new version's sha. Only works when a previous version was archived
 * (revisions made after the version-archive feature shipped).
 */
export async function restorePreviousVersion(publicId: string): Promise<{ sha256Index: string }> {
  const { data } = await api.post<{ sha256Index: string }>(`/api/publish/${publicId}/restore`, {});
  return data;
}

/**
 * Publish an artifact as a hosted static bundle (/p/u/{userId}/{slug}) via the
 * 3-step flow: request presigned upload -> PUT index.html to S3 -> finalize.
 *
 * The artifact is rendered to a single static index.html. `html`/`svg` artifacts
 * become real pages; other types render their source in a <pre> (interactive JS
 * artifacts are static-only until the sandbox-origin work lands, so inline scripts
 * are stripped at serve time).
 */
export async function publishArtifactBundle(input: {
  artifactId: string;
  type: string;
  content: string;
  title: string;
  userId: string;
  /**
   * Scope tier to publish under. Defaults to `'user'` (a personal `/p/u/{userId}` page).
   * Pass `'organization'` with `scopeId` set to the org id to publish an org-scoped page
   * (`/p/o/{orgId}`) that the serve gate authorizes to org members - see `artifactBundlePublisher`.
   */
  tier?: PublishScopeTier;
  /** Scope id for `tier`. Defaults to `userId` (user tier). For org tier, the org id. */
  scopeId?: string;
  visibility?: PublishVisibility;
  commentPolicy?: CommentPolicy;
  /**
   * Publish to this exact slug instead of deriving one from the title. Pass the existing
   * publication's slug to land a new VERSION of it (finalize upserts on
   * tier+scopeId+slug) rather than a separate page, even if the title has since drifted
   * during notebook iteration.
   */
  slug?: string;
  /**
   * "Publish as new" of an artifact that already has one or more publications: append a
   * fresh discriminator to the derived slug so the upsert can never land on a prior
   * publication. Set by the dialog only when the user picks "new" AND a prior publication
   * was found. Ignored when an explicit `slug` is given (that's the "update" path).
   */
  forceUniqueSlug?: boolean;
}): Promise<PublishResult> {
  const content = (input.content ?? '').trim();
  if (!content) throw new Error('This artifact has no content to publish');

  const indexHtml = buildArtifactIndexHtml(input.type, input.content, input.title);
  const size = new TextEncoder().encode(indexHtml).length;
  let slug = input.slug ?? `${slugify(input.title) || 'artifact'}-${input.artifactId.slice(0, 6)}`;
  // "Publish as new" must land a SEPARATE page. finalize upserts on tier+scopeId+slug, so a
  // derived slug that matches ANY prior publication of this artifact (same artifactId, and a
  // title that again slugifies the same) would silently append a version to it instead.
  // Since findPublishedByArtifact only surfaces the most-recent match, comparing against a
  // single slug misses older siblings - so append a fresh discriminator unconditionally to
  // guarantee a new record.
  if (!input.slug && input.forceUniqueSlug) {
    slug = `${slug}-${uniqueSlugDiscriminator()}`;
  }

  // Step 1 - request a presigned PUT for index.html.
  const { data: draft } = await api.post<UploadUrlResponse>('/api/publish/artifact/upload-url', {
    tier: input.tier ?? 'user',
    scopeId: input.scopeId ?? input.userId,
    slug,
    title: input.title || 'Shared artifact',
    visibility: input.visibility ?? DEFAULT_SHARE_VISIBILITY,
    ...(input.commentPolicy ? { commentPolicy: input.commentPolicy } : {}),
    source: { kind: 'bundle', artifactId: input.artifactId },
    files: [{ path: 'index.html', size, mimeType: 'text/html' }],
  });

  // Step 2 - PUT the bytes directly to S3 (plain fetch; no app auth header).
  const put = draft.uploadUrls.find(u => u.path === 'index.html');
  if (!put) throw new Error('Upload URL was not issued for index.html');
  const res = await fetch(put.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/html' },
    body: indexHtml,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);

  // Step 3 - finalize (validates + promotes + upserts).
  const { data: result } = await api.post<PublishResult>('/api/publish/artifact/finalize', {
    draftId: draft.draftId,
  });
  return result;
}

/** Options the share dialog passes to an artifact-bundle publish callback. */
export interface ArtifactPublishOpts {
  /** Whether to land a new version on the existing publication or create a new page. */
  mode: PublishMode;
  /**
   * The existing publication's slug, supplied by the dialog whenever a prior publication
   * was found. In 'update' mode it pins the upsert; its mere presence in 'new' mode signals
   * that a prior publication exists, so the publisher forces a unique slug for the new page.
   */
  existingSlug?: string;
}

/**
 * Build the share-dialog publish callback for an artifact bundle. The dialog
 * decides the mode: "update" reuses the existing publication's slug (passed back as
 * `existingSlug`) so finalize appends a version; "new" (the default) derives a fresh
 * slug for a separate page.
 *
 * When the caller is in an org ("Team") account context, `orgId` enables the dialog's
 * Team option: picking `'organization'` visibility publishes an org-tier page
 * (`tier:'organization'`, `scopeId=orgId` → `/p/o/{orgId}/{slug}`). This is the ONLY
 * combination the serve gate authorizes to org members - a user-tier page with org
 * visibility would 403 for everyone but the owner (its scopeId is the user id, never the
 * viewer's org id). The server re-validates org membership before trusting the scope.
 */
export function artifactBundlePublisher(input: {
  artifactId: string;
  type: string;
  content: string;
  title: string;
  userId: string;
  /** The caller's active org, when in a "Team" account context. Undefined for personal scope. */
  orgId?: string;
}): (visibility: PublishVisibility, opts?: ArtifactPublishOpts) => Promise<PublishResult> {
  const { orgId, ...bundle } = input;
  return (visibility, opts) =>
    publishArtifactBundle({
      ...bundle,
      visibility,
      // Org visibility publishes a real org-tier page (scopeId = org id) so same-org members
      // can view it - see orgTierFields.
      ...orgTierFields(visibility, orgId),
      // 'update' pins the existing slug so finalize appends a version; 'new' with a prior
      // publication forces a unique slug so it can't collide back onto ANY existing one.
      ...(opts?.mode === 'update' && opts.existingSlug
        ? { slug: opts.existingSlug }
        : opts?.mode === 'new' && opts.existingSlug
          ? { forceUniqueSlug: true }
          : {}),
    });
}

/**
 * Wire the share dialog for an artifact so the "update existing" LOOKUP and the PUBLISH are
 * guaranteed to key on the SAME artifact id. Every publish surface (the chat artifact
 * card and the full viewer) routes through this one entry point: pass a single `artifactId`
 * and it feeds BOTH `resolveExisting` and the publisher, so the id can never drift between the
 * lookup and the write. A drifted id (e.g. a positional `artifact-<tabIndex>` fallback) both
 * misses the lookup - silently degrading "update existing" to publish-as-new - AND gets
 * persisted as `source.artifactId`, corrupting the linkage. Callers must pass a stable id.
 */
export function buildArtifactPublishWiring(input: {
  artifactId: string;
  type: string;
  content: string;
  title: string;
  userId: string;
  /** The caller's active org, when in a "Team" account context. Enables org-scoped publishing. */
  orgId?: string;
}): {
  resolveExisting: () => Promise<ManagedArtifact | null>;
  publish: (visibility: PublishVisibility, opts?: ArtifactPublishOpts) => Promise<PublishResult>;
} {
  return {
    resolveExisting: () => findPublishedByArtifact(input.artifactId),
    publish: artifactBundlePublisher(input),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * A short, collision-resistant slug discriminator for "publish as new": 3 base-36
 * timestamp chars (rough ordering) + 3 random base-36 chars. The random tail is what
 * separates two publishes fired in the SAME millisecond - a time-only discriminator would
 * hand both the identical suffix and collide them back onto one slug. Always exactly 6
 * chars so the discriminated slug stays within SlugSchema's 64-char cap.
 */
function uniqueSlugDiscriminator(): string {
  const time = Date.now().toString(36).slice(-3);
  const rand = Math.floor(Math.random() * 46656) // 36^3 -> 3 base-36 chars
    .toString(36)
    .padStart(3, '0');
  return `${time}${rand}`;
}

/** Render an artifact to a single static index.html based on its type. */
function buildArtifactIndexHtml(type: string, content: string, title: string): string {
  const t = escapeHtml(title || 'Shared artifact');
  // Full HTML doc -> serve as-is, but still inject the lead-gen footer before
  // </body> (fall back to appending) so every published page is branded.
  if (type === 'html' && /<html[\s>]/i.test(content)) {
    const footer = buildShareFooterHtml({ source: 'artifact' });
    return /<\/body>/i.test(content) ? content.replace(/<\/body>/i, `${footer}</body>`) : content + footer;
  }

  const PAGE = (inner: string, extraStyle = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${t}"><title>${t}</title>
<style>:root{color-scheme:light dark}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.6;max-width:900px;margin:0 auto;padding:2rem 1.25rem 4rem}pre{background:rgba(127,127,127,.12);padding:1rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word}img,svg{max-width:100%;height:auto}${extraStyle}</style>
</head><body>${inner}${buildShareFooterHtml({ source: 'artifact' })}</body></html>`;

  if (type === 'html') return PAGE(content); // HTML fragment
  if (type === 'svg') return PAGE(content); // inline SVG markup
  // Source-bearing types (code/python/react/recharts/mermaid/json/...) -> code view.
  return PAGE(`<pre><code>${escapeHtml(content)}</code></pre>`);
}

/** Absolute, shareable URL for a publish result (e.g. https://app.example.com/p/r/abc123). */
export function toShareUrl(result: Pick<PublishResult, 'url'>): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${result.url}`;
  }
  return result.url;
}

/** Absolute no-sign-in share URL for a share token (e.g. https://app.example.com/a/<token>). */
export function toShareTokenUrl(shareToken: string): string {
  const path = `/a/${shareToken}`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
}

/**
 * Mint (idempotent) or fetch the no-sign-in share token for a published artifact
 * (owner/admin). Pass `regenerate: true` to rotate it, which immediately revokes
 * every outstanding `/a` link. Returns the token and its relative `/a/<token>` path.
 */
export async function createOrGetShareToken(
  publicId: string,
  regenerate = false
): Promise<{ shareToken: string; shareUrl: string }> {
  const { data } = await api.post<{ shareToken: string; shareUrl: string }>(`/api/publish/${publicId}/share-token`, {
    regenerate,
  });
  return data;
}

/** Rotate the share token (revokes all outstanding `/a` links), returning the new one. */
export async function regenerateShareToken(publicId: string): Promise<{ shareToken: string; shareUrl: string }> {
  return createOrGetShareToken(publicId, true);
}

/** Revoke the share token so every `/a` link 404s immediately (owner/admin). */
export async function revokeShareToken(publicId: string): Promise<void> {
  await api.delete(`/api/publish/${publicId}/share-token`);
}

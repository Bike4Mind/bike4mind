import {
  downloadPublishedIndex,
  deleteRetiredPublishedIndex,
  publishedContentSnapshotFilter,
} from '@bike4mind/server-utils/services/publish/currentIndex';
import { assertPublicationPublicLink } from '@server/services/publish/organizationPolicy';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import { isDuplicateKeyError } from '@bike4mind/server-utils/utils/isDuplicateKeyError';
import { enqueuePublishThumbnail } from '@bike4mind/server-utils/utils/publishThumbnails';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  HTTPError,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/server-utils/utils/errors';
import { PublishedArtifact, liveShareTokens, type PublishedArtifactShareToken } from '@bike4mind/database';
import {
  PUBLISH_LIMITS,
  ALLOWED_MIME_PREFIXES,
  ALLOWED_MIME_EXACT,
  ArtifactTypeSchema,
  SLUG_OWNED_BY_OTHER,
  normalizePublishTags,
  type ArtifactFile,
  type PublishResult,
  type UploadUrlRequest,
  type UploadUrlResponse,
  type ValidationViolation,
} from '@bike4mind/common';
import {
  validateBundle,
  checkScopePermission,
  resolveVisibility,
  archivedVersionBytes,
  checkPublishQuota,
  consumePublishAction,
  mintDraftUploadUrl,
  planVersionedPublish,
  versionsPushUpdate,
  buildPublishS3KeyPrefix,
  buildPublishUrlPath,
  invalidatePublishCdn,
  toCacheTarget,
  validateEmbedOrigins,
  buildReactArtifactBundle,
  renderArtifactIndexHtml,
  UnsupportedReactDependencyError,
  ReactArtifactTranspileError,
  mayRepublishSlug,
  type PublishUser,
} from '@server/services/publish';
import { decodeReactPublishUpload } from '@client/app/utils/reactArtifactPublish';

/**
 * Business logic of the bundle publish flow: `createBundleUpload` issues a draft and its upload
 * targets, `finalizeBundle` promotes the draft to the canonical key and upserts the record. The
 * legacy `/api/publish/artifact/{upload-url,finalize}` handlers and the v1 routes both call these.
 *
 * Failures throw HTTP errors whose `additionalInfo.errorCode` is one of {@link PUBLISH_BUNDLE_ERROR_CODES}
 * (or a code from a shared helper: quota, embed origins, visibility). Legacy handlers turn them back
 * into their historical `{ error, code? }` bodies with {@link toLegacyPublishErrorResponse}.
 */

export interface PublishLogger {
  info: (message: string) => unknown;
  warn: (message: string, meta?: Record<string, unknown>) => unknown;
}

export type BundlePublisher = PublishUser & { createdAt?: Date | string | null };

const PRESIGNED_URL_EXPIRY_SECONDS = 600; // 10 minutes

/** Error codes minted here. Each throws the HTTP status noted beside it. */
export const PUBLISH_BUNDLE_ERROR_CODES = {
  tooManyFiles: 'too_many_files', // 400
  invalidFilePath: 'invalid_file_path', // 400
  fileTooLarge: 'file_too_large', // 400
  disallowedMimeType: 'disallowed_mime_type', // 400
  bundleTooLarge: 'bundle_too_large', // 400
  missingIndexHtml: 'missing_index_html', // 400
  scopeNotPermitted: 'scope_not_permitted', // 401 | 403 | 404
  invalidDraftId: 'invalid_draft_id', // 400
  draftNotFound: 'draft_not_found', // 404
  draftNotOwned: 'draft_not_owned', // 403
  draftVisibilityInvalid: 'draft_visibility_invalid', // 400
  validationFailed: 'validation_failed', // 422, additionalInfo.violations
  slugOwnedByOther: SLUG_OWNED_BY_OTHER, // 403 on a republish by a non-owner, 409 on a lost race
  invalidVisibilityOverride: 'invalid_override', // 400
} as const;

// Codes from this file that the legacy bodies never carried as `code`.
const LEGACY_UNCODED = new Set<string>([
  PUBLISH_BUNDLE_ERROR_CODES.tooManyFiles,
  PUBLISH_BUNDLE_ERROR_CODES.invalidFilePath,
  PUBLISH_BUNDLE_ERROR_CODES.fileTooLarge,
  PUBLISH_BUNDLE_ERROR_CODES.disallowedMimeType,
  PUBLISH_BUNDLE_ERROR_CODES.bundleTooLarge,
  PUBLISH_BUNDLE_ERROR_CODES.missingIndexHtml,
  PUBLISH_BUNDLE_ERROR_CODES.scopeNotPermitted,
  PUBLISH_BUNDLE_ERROR_CODES.invalidDraftId,
  PUBLISH_BUNDLE_ERROR_CODES.draftNotFound,
  PUBLISH_BUNDLE_ERROR_CODES.draftNotOwned,
  PUBLISH_BUNDLE_ERROR_CODES.draftVisibilityInvalid,
  PUBLISH_BUNDLE_ERROR_CODES.validationFailed,
]);

/**
 * Maps an error thrown by this file's services to the legacy `{ error, code?, details?, violations? }`
 * response, or null for anything else (rate limits, organization policy, unexpected failures), which
 * the caller rethrows to the shared error handler as before.
 */
export function toLegacyPublishErrorResponse(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(err instanceof HTTPError)) return null;
  const { errorCode, details, violations } = (err.additionalInfo ?? {}) as {
    errorCode?: unknown;
    details?: unknown;
    violations?: unknown;
  };
  if (typeof errorCode !== 'string') return null;
  return {
    status: err.statusCode,
    body: {
      error: err.message,
      ...(LEGACY_UNCODED.has(errorCode) ? {} : { code: errorCode }),
      ...(details !== undefined ? { details } : {}),
      ...(violations !== undefined ? { violations } : {}),
    },
  };
}

function validationFailed(violations: ValidationViolation[]): UnprocessableEntityError {
  return new UnprocessableEntityError('Validation failed', {
    errorCode: PUBLISH_BUNDLE_ERROR_CODES.validationFailed,
    violations,
  });
}

function slugOwnedByOther(message: string, make: typeof ForbiddenError | typeof ConflictError) {
  return new make(message, { errorCode: PUBLISH_BUNDLE_ERROR_CODES.slugOwnedByOther });
}

function isAllowedMime(mimeType: string): boolean {
  return ALLOWED_MIME_EXACT.includes(mimeType) || ALLOWED_MIME_PREFIXES.some(p => mimeType.startsWith(p));
}

/** Short public id for /p/r|f URLs (no nanoid dep in this package). */
export function uuidPublicId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function decodeReactUpload(raw: string, siblings: string[]): { source: string; files: Record<string, string> } {
  try {
    const { entry, files } = decodeReactPublishUpload(raw, siblings);
    return { source: entry, files };
  } catch (err) {
    throw new ReactArtifactTranspileError((err as Error).message);
  }
}

async function assertScope(user: PublishUser, tier: UploadUrlRequest['tier'], scopeId: string) {
  const perm = await checkScopePermission({ user, tier, scopeId });
  if (!perm.ok) {
    throw new HTTPError(perm.status, perm.error, { errorCode: PUBLISH_BUNDLE_ERROR_CODES.scopeNotPermitted });
  }
}

function assertVisibility(tier: UploadUrlRequest['tier'], visibility: string | undefined) {
  const viz = resolveVisibility(tier, visibility as UploadUrlRequest['visibility']);
  if (!viz.ok) {
    throw new BadRequestError(viz.error, { errorCode: viz.code });
  }
  return viz;
}

export interface CreateBundleUploadInput extends UploadUrlRequest {
  user: BundlePublisher;
  logger: PublishLogger;
}

/** Validates the bundle declaration, writes the draft manifest, and mints one upload target per file. */
export async function createBundleUpload(input: CreateBundleUploadInput): Promise<UploadUrlResponse> {
  const { user, logger, ...body } = input;

  if (body.files.length > PUBLISH_LIMITS.maxFiles) {
    throw new BadRequestError(`Too many files (max ${PUBLISH_LIMITS.maxFiles})`, {
      errorCode: PUBLISH_BUNDLE_ERROR_CODES.tooManyFiles,
    });
  }
  let totalBytes = 0;
  for (const f of body.files) {
    // Path hygiene: no traversal, no absolute/backslash paths, no control chars,
    // and not the reserved server-written draft manifest (an attacker could
    // otherwise request a presigned PUT to overwrite drafts/{id}/_manifest.json).
    if (
      !f.path ||
      f.path.includes('..') ||
      f.path.startsWith('/') ||
      f.path.includes('\\') ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/.test(f.path) ||
      f.path === '_manifest.json'
    ) {
      throw new BadRequestError(`Invalid file path: ${f.path}`, {
        errorCode: PUBLISH_BUNDLE_ERROR_CODES.invalidFilePath,
      });
    }
    if (f.size > PUBLISH_LIMITS.maxFileBytes) {
      throw new BadRequestError(`File ${f.path} exceeds per-file limit`, {
        errorCode: PUBLISH_BUNDLE_ERROR_CODES.fileTooLarge,
      });
    }
    totalBytes += f.size;
    if (!isAllowedMime(f.mimeType)) {
      throw new BadRequestError(`Disallowed MIME type for ${f.path}: ${f.mimeType}`, {
        errorCode: PUBLISH_BUNDLE_ERROR_CODES.disallowedMimeType,
      });
    }
  }
  if (totalBytes > PUBLISH_LIMITS.maxBundleBytes) {
    throw new BadRequestError('Bundle exceeds total size limit', {
      errorCode: PUBLISH_BUNDLE_ERROR_CODES.bundleTooLarge,
    });
  }
  const rootIndex = body.files.filter(f => f.path === 'index.html');
  if (rootIndex.length !== 1) {
    throw new BadRequestError('Bundle must contain exactly one index.html at the root', {
      errorCode: PUBLISH_BUNDLE_ERROR_CODES.missingIndexHtml,
    });
  }

  await assertScope(user, body.tier, body.scopeId);
  const viz = assertVisibility(body.tier, body.visibility);
  if (viz.visibility === 'public') await assertPublicationPublicLink(body);

  const existing = await PublishedArtifact.findOne({
    tier: body.tier,
    scopeId: body.scopeId,
    slug: body.slug,
    deletedAt: null,
  })
    .select('ownerId sha256Index versions')
    .lean<{
      ownerId: string;
      sha256Index?: string;
      versions?: Array<{ sha256Index: string; indexBytes?: number }>;
    } | null>();
  if (existing && !mayRepublishSlug(existing.ownerId, user)) {
    throw slugOwnedByOther('Only the owner can republish this slug', ForbiddenError);
  }

  // Cumulative per-owner storage quota (bytes only; no page-count cap), checked before issuing
  // presigned URLs so no S3 PUTs are wasted. A bundle publish targets a fixed {tier,scopeId,slug}:
  // an existing row there is an in-place overwrite, so it is excluded from usage (a missing one
  // makes the exclusion a no-op). The page's earlier versions stay archived through the overwrite
  // and are added back; whether the current version is archived too depends on the new bytes,
  // which finalize checks.
  const quota = await checkPublishQuota({
    ownerId: user.id,
    orgScopeId: body.tier === 'organization' ? body.scopeId : null,
    isAdmin: user.isAdmin,
    incoming: {
      bytes: totalBytes,
      fileCount: body.files.length,
      archivedBytes: archivedVersionBytes(existing?.versions, existing?.sha256Index),
    },
    replacing: { tier: body.tier, scopeId: body.scopeId, slug: body.slug },
  });
  if (!quota.ok) {
    throw new HTTPError(quota.status, quota.error, { errorCode: quota.code, details: quota.details });
  }

  // The daily publish allowance is counted here, once per bundle publish: finalize only promotes
  // the draft this issues. Throws a 429 when used up. If the draft then cannot be issued, no draft
  // id reaches the caller, so the action is handed back.
  const action = await consumePublishAction(user);
  const refundAndRethrow = async (err: unknown): Promise<never> => {
    await action.refund();
    throw err;
  };

  const draftId = crypto.randomUUID();
  const draftPrefix = `drafts/${draftId}/`;
  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  const draftTags = normalizePublishTags(body.tags ?? []);
  const draftManifest = {
    draftId,
    createdAt: new Date().toISOString(),
    createdBy: user.id,
    tier: body.tier,
    scopeId: body.scopeId,
    slug: body.slug,
    title: body.title,
    description: body.description,
    // Carried on the draft so finalize writes them with the artifact. Normalize FIRST and only carry
    // a non-empty result, so neither `[]` nor `['  ']` travels as "clear the tags"; finalize guards
    // the same way.
    tags: draftTags.length ? draftTags : undefined,
    visibility: viz.visibility,
    gatedToGroupId: body.gatedToGroupId,
    commentPolicy: body.commentPolicy ?? 'none',
    // Finalize applies the host/open-public rules once the final visibility is settled.
    embedOrigins: body.embedOrigins,
    source: body.source ?? { kind: 'bundle' as const },
    files: body.files,
  };

  const storage = getPublishedArtifactsStorage();
  await storage
    .upload(Buffer.from(JSON.stringify(draftManifest)), `${draftPrefix}_manifest.json`, {
      ContentType: 'application/json',
    })
    .catch(refundAndRethrow);

  // Hosted -> presigned S3 PUT; self-host -> same-origin proxy URL plus a token header (draftUploadUrl.ts).
  const uploadUrls: UploadUrlResponse['uploadUrls'] = await Promise.all(
    body.files.map(async file => {
      const target = await mintDraftUploadUrl({
        storage,
        key: `${draftPrefix}${file.path}`,
        draftId,
        path: file.path,
        mimeType: file.mimeType,
        size: file.size,
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      });
      return { path: file.path, ...target, expiresAt };
    })
  ).catch(refundAndRethrow);

  logger.info(
    `[PUBLISH] upload-url draft=${draftId} ${body.tier}/${body.scopeId}/${body.slug} files=${body.files.length} user=${user.id}`
  );

  return { draftId, uploadUrls };
}

const DraftManifestSchema = z.object({
  draftId: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  tier: z.enum(['user', 'project', 'organization']),
  scopeId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']),
  gatedToGroupId: z.string().optional(),
  commentPolicy: z.enum(['none', 'open', 'restricted']).optional(),
  embedOrigins: z.array(z.string()).optional(),
  source: z.object({
    kind: z.enum(['bundle', 'reply', 'fabfile']),
    artifactId: z.string().optional(),
    sessionId: z.string().optional(),
    messageId: z.string().optional(),
    fabFileId: z.string().optional(),
    // Raw artifact content uploaded as index.html; rendered server-side at finalize. `react`
    // transpiles to an inert bundle; every other type is wrapped by renderArtifactIndexHtml.
    // Absent means the bytes are already the final page.
    artifactType: ArtifactTypeSchema.optional(),
    // With artifactType 'react': index.html is a JSON { entry, files } upload of a multi-file app.
    reactSiblings: z.array(z.string()).optional(),
  }),
  files: z.array(z.object({ path: z.string(), size: z.number(), mimeType: z.string() })),
});
type DraftManifest = z.infer<typeof DraftManifestSchema>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface FinalizeBundleInput {
  user: BundlePublisher;
  logger: PublishLogger;
  draftId: string;
}

/** Promotes a draft to its canonical key, upserts the PublishedArtifact record, and returns the page identity. */
export async function finalizeBundle(input: FinalizeBundleInput): Promise<PublishResult> {
  const { user, logger, draftId } = input;
  if (!UUID_V4.test(draftId)) {
    throw new BadRequestError('Invalid draftId format', { errorCode: PUBLISH_BUNDLE_ERROR_CODES.invalidDraftId });
  }

  const draftPrefix = `drafts/${draftId}/`;
  const storage = getPublishedArtifactsStorage();

  // 1. Read draft manifest
  const draftNotFound = () =>
    new NotFoundError('Draft not found or expired', { errorCode: PUBLISH_BUNDLE_ERROR_CODES.draftNotFound });
  let manifest: DraftManifest;
  try {
    const buf = await storage.download(`${draftPrefix}_manifest.json`);
    const m = DraftManifestSchema.safeParse(JSON.parse(buf.toString('utf-8')));
    if (!m.success) throw draftNotFound();
    manifest = m.data;
  } catch {
    throw draftNotFound();
  }

  // 2. Re-check permission (defense in depth)
  if (manifest.createdBy !== user.id && !user.isAdmin) {
    throw new ForbiddenError('You did not create this draft', { errorCode: PUBLISH_BUNDLE_ERROR_CODES.draftNotOwned });
  }
  await assertScope(user, manifest.tier, manifest.scopeId);
  const viz = resolveVisibility(manifest.tier, manifest.visibility);
  if (!viz.ok || viz.visibility !== manifest.visibility) {
    throw new BadRequestError('Draft visibility is no longer valid for this scope', {
      errorCode: PUBLISH_BUNDLE_ERROR_CODES.draftVisibilityInvalid,
    });
  }
  if (manifest.visibility === 'public') await assertPublicationPublicLink(manifest);

  // 3. Verify every file exists + collect metadata
  const filesWithMeta: ArtifactFile[] = [];
  const violations: ValidationViolation[] = [];
  const bufferCache = new Map<string, Buffer>();

  for (const declared of manifest.files) {
    try {
      const buf = await storage.download(`${draftPrefix}${declared.path}`);
      if (buf.length > PUBLISH_LIMITS.maxFileBytes) {
        violations.push({
          type: 'size_exceeded',
          message: `File ${declared.path} (${buf.length}B) exceeds per-file limit`,
          file: declared.path,
        });
        continue;
      }
      filesWithMeta.push({
        path: declared.path,
        size: buf.length,
        mimeType: declared.mimeType,
        sha256: createHash('sha256').update(buf).digest('hex'),
      });
      bufferCache.set(declared.path, buf);
    } catch {
      violations.push({
        type: 'invalid_asset_url',
        message: `Expected file missing from draft: ${declared.path}`,
        file: declared.path,
      });
    }
  }
  if (violations.length > 0) throw validationFailed(violations);

  // 4. Locate index.html (required)
  const indexEntry = filesWithMeta.find(f => f.path === 'index.html');
  if (!indexEntry) {
    throw validationFailed([{ type: 'missing_index', message: 'Bundle must contain an index.html at root' }]);
  }

  // 4a. React artifacts upload raw JSX as index.html; transpile it into a self-contained inert
  // HTML bundle here so the size caps, validateBundle, and promote below all operate on the FINAL
  // served bytes. Rejectable input (unsupported dep / bad JSX / unresolvable import) becomes a
  // clean 422 violation rather than a broken published page.
  if (manifest.source.artifactType === 'react') {
    try {
      const uploaded = bufferCache.get('index.html')!.toString('utf-8');
      const siblings = manifest.source.reactSiblings;
      const { indexHtml: bundled } = await buildReactArtifactBundle(
        siblings
          ? { ...decodeReactUpload(uploaded, siblings), title: manifest.title }
          : { source: uploaded, title: manifest.title }
      );
      const buf = Buffer.from(bundled, 'utf-8');
      bufferCache.set('index.html', buf);
      indexEntry.size = buf.length;
      indexEntry.sha256 = createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      if (err instanceof UnsupportedReactDependencyError || err instanceof ReactArtifactTranspileError) {
        throw validationFailed([{ type: 'forbidden_pattern', message: err.message, file: 'index.html' }]);
      }
      throw err;
    }
  } else if (manifest.source.artifactType) {
    // Non-react artifact types signal "render this raw content server-side": wrap the uploaded
    // source into the canonical published page (bytes pinned in renderArtifactHtml.test.ts).
    const rendered = renderArtifactIndexHtml(
      manifest.source.artifactType,
      bufferCache.get('index.html')!.toString('utf-8'),
      manifest.title
    );
    const buf = Buffer.from(rendered, 'utf-8');
    bufferCache.set('index.html', buf);
    indexEntry.size = buf.length;
    indexEntry.sha256 = createHash('sha256').update(buf).digest('hex');
  }

  // 4b. Size caps (post-transpile, so a React bundle's FINAL size is what's enforced)
  const totalBytes = filesWithMeta.reduce((sum, f) => sum + f.size, 0);
  if (indexEntry.size > PUBLISH_LIMITS.maxFileBytes) {
    throw validationFailed([
      {
        type: 'size_exceeded',
        message: `index.html (${indexEntry.size}B) exceeds per-file limit`,
        file: 'index.html',
      },
    ]);
  }
  if (totalBytes > PUBLISH_LIMITS.maxBundleBytes) {
    throw validationFailed([{ type: 'size_exceeded', message: `Bundle total ${totalBytes}B exceeds cap` }]);
  }

  // 4c. Validate the (possibly transpiled) index.html
  const validation = validateBundle({
    indexHtml: bufferCache.get('index.html')!.toString('utf-8'),
    manifest: filesWithMeta.map(f => ({ path: f.path, mimeType: f.mimeType })),
  });
  if (!validation.valid) throw validationFailed(validation.violations);

  // 5. Previous version (overwrite-in-place forensics)
  const previous = await PublishedArtifact.findOne({
    tier: manifest.tier,
    scopeId: manifest.scopeId,
    slug: manifest.slug,
    deletedAt: null,
  })
    .select(
      'publicId publishedAt ownerId lastPublishedBy size sha256Index indexObjectPath versions accessGate visibility shareTokens source.artifactId v1ArtifactId'
    )
    .lean<{
      publicId: string;
      publishedAt: Date;
      ownerId: string;
      lastPublishedBy?: string;
      size: { totalBytes: number; fileCount: number };
      sha256Index?: string;
      indexObjectPath?: string | null;
      versions?: Array<{ sha256Index: string; indexBytes?: number }>;
      accessGate?: unknown;
      visibility?: string;
      shareTokens?: PublishedArtifactShareToken[];
      source?: { artifactId?: string };
      v1ArtifactId?: string;
    } | null>();

  if (previous && !mayRepublishSlug(previous.ownerId, user)) {
    throw slugOwnedByOther('Only the owner can republish this slug', ForbiddenError);
  }
  if (previous?.shareTokens?.length && liveShareTokens(previous).length > 0)
    await assertPublicationPublicLink(manifest);

  // 5a. The prior canonical index.html, archived at step 6 before this overwrite so its bytes
  // survive in version history (served later via ?v={sha}). Read here because what it archives
  // counts toward the quota below. Best-effort: nothing to archive on a first promote / missing prior.
  const canonicalPrefix = buildPublishS3KeyPrefix(manifest.tier, manifest.scopeId, manifest.slug);
  const priorIndex = previous?.sha256Index
    ? await downloadPublishedIndex({ ...previous, storageKeyPrefix: canonicalPrefix }, storage).catch(() => null)
    : null;

  // 5b. Version history (deduped by content sha, `previous` null -> [new] only) and 5c, the cumulative
  // per-owner quota re-check (defense in depth - the draft may have been issued before other publishes
  // consumed the allowance). One call: the quota counts the archived versions as they stand after this publish.
  const now = new Date();
  const { versionsToPush, quota } = await planVersionedPublish({
    previous,
    priorIndex,
    incoming: {
      sha256: indexEntry.sha256,
      publishedBy: user.id,
      publishedAt: now,
      size: { totalBytes, fileCount: filesWithMeta.length },
      indexBytes: indexEntry.size,
    },
    quota: {
      ownerId: user.id,
      orgScopeId: manifest.tier === 'organization' ? manifest.scopeId : null,
      isAdmin: user.isAdmin,
      replacing: { tier: manifest.tier, scopeId: manifest.scopeId, slug: manifest.slug },
    },
  });
  if (!quota.ok) {
    throw new HTTPError(quota.status, quota.error, { errorCode: quota.code, details: quota.details });
  }

  // Validate the embed allowlist against the artifact's FINAL open-public state. A re-publish
  // PRESERVES the previous access gate (it is not in the $set below), so open-public means
  // visibility public AND no preserved gate - matching the PATCH path.
  const embed = validateEmbedOrigins(manifest.embedOrigins, {
    isOpenPublic: manifest.visibility === 'public' && !previous?.accessGate,
  });
  if (!embed.ok) {
    throw new BadRequestError(embed.error, { errorCode: embed.code });
  }

  // 6. Promote draft -> canonical prefix, archiving the prior index.html read at 5a first. Best-effort.
  let archivedPrevious = false;
  if (previous?.sha256Index && priorIndex) {
    try {
      await storage.upload(priorIndex, `${canonicalPrefix}versions/${previous.sha256Index}.html`, {
        ContentType: 'text/html',
      });
      archivedPrevious = true;
    } catch (error) {
      logger.warn('[PUBLISH] Could not archive the prior page; retaining its payload', { error });
    }
  }
  for (const file of filesWithMeta) {
    await storage.upload(bufferCache.get(file.path)!, `${canonicalPrefix}${file.path}`, {
      ContentType: file.mimeType,
    });
  }
  bufferCache.clear();

  // 7. Upsert record (versionsToPush from 5b)
  const publicId = previous?.publicId ?? uuidPublicId();
  const publishTags = normalizePublishTags(manifest.tags ?? []);
  const ownerId = previous ? previous.ownerId : user.id;
  const update = {
    $set: {
      publicId,
      title: manifest.title,
      description: manifest.description,
      // Guarded on the NORMALIZED length, not the raw one: `[]` is truthy and `['  ']` normalizes to
      // `[]`, so a client that always sends the field would otherwise clear tags on every re-publish.
      // A publish can only ADD tags; clearing belongs to the PATCH path.
      ...(publishTags.length ? { tags: publishTags } : {}),
      visibility: manifest.visibility,
      gatedToGroupId: manifest.gatedToGroupId,
      commentPolicy: manifest.commentPolicy ?? 'none',
      // Like accessGate, the embed allowlist is managed post-publish via PATCH. Only write a
      // NON-EMPTY validated list so a plain re-publish can only ADD grants, never clobber to [].
      ...(embed.value.length > 0 ? { embedOrigins: embed.value } : {}),
      ownerId,
      lastPublishedBy: user.id,
      source: manifest.source,
      storageKeyPrefix: canonicalPrefix,
      size: { totalBytes, fileCount: filesWithMeta.length },
      sha256Index: indexEntry.sha256,
      manifest: filesWithMeta,
      publishedAt: now,
      previousVersionMeta: previous
        ? {
            publishedAt: previous.publishedAt,
            publishedBy: previous.lastPublishedBy ?? previous.ownerId,
            size: previous.size,
            sha256Index: previous.sha256Index ?? '',
          }
        : undefined,
    },
    // Append this version to the history (oldest -> newest), deduped by content sha and
    // backfilling the replaced version if not yet recorded. Bytes for the current entry live at
    // index.html; older entries at versions/{sha}.html.
    ...versionsPushUpdate(versionsToPush),
  };
  const scope = { tier: manifest.tier, scopeId: manifest.scopeId, slug: manifest.slug, deletedAt: null, ownerId };
  // Replacing a v1-published page with a different artifact must drop its one-page-per-artifact
  // marker, or the old artifact stays locked out of publishing elsewhere.
  const v1MarkerUnset =
    previous?.v1ArtifactId && previous.v1ArtifactId !== manifest.source.artifactId ? { v1ArtifactId: 1 } : {};
  // A first publish includes its newly allocated identity in the upsert filter, so it cannot
  // match a competing publisher's row. The unique live-slug index rejects that insert instead.
  // update-validators-off: moved verbatim from the finalize handler; publish-time validation is done above
  const saved = await PublishedArtifact.findOneAndUpdate(
    { ...scope, publicId, ...(previous ? { ...publishedContentSnapshotFilter(previous), revisingAt: null } : {}) },
    { ...update, ...(previous ? { $unset: { indexObjectPath: 1, ...v1MarkerUnset } } : {}) },
    { upsert: !previous, new: true }
  ).catch((err: unknown) => {
    if (isDuplicateKeyError(err)) return null;
    throw err;
  });
  if (!saved) {
    throw slugOwnedByOther('This slug was published by another request', ConflictError);
  }

  if (previous && archivedPrevious) {
    await deleteRetiredPublishedIndex({ ...previous, storageKeyPrefix: canonicalPrefix }, storage, error =>
      logger.warn('[PUBLISH] Could not remove a retired page payload', { error })
    );
  }

  // 7b. The public `/p/...` page is CDN-cached, so purge it after an overwrite. Gated pages are
  // no-store, so skip unless the page is or WAS public (a downgrade must purge the public copy). Best-effort.
  if (saved.visibility === 'public' || previous?.visibility === 'public') {
    await invalidatePublishCdn(toCacheTarget(saved), logger);
  }

  // 7c. Owner-only thumbnail of the version just promoted. Best-effort and never throws: a failed
  // enqueue leaves the card on its generated cover.
  if (manifest.source.kind === 'bundle') {
    await enqueuePublishThumbnail({ publicId: saved.publicId, versionId: indexEntry.sha256 }, logger);
  }

  // 8. Best-effort draft cleanup
  void (async () => {
    try {
      for (const file of manifest.files) {
        await storage.delete(`${draftPrefix}${file.path}`).catch(() => undefined);
      }
      await storage.delete(`${draftPrefix}_manifest.json`).catch(() => undefined);
    } catch {
      logger.warn(`[PUBLISH] finalize: draft cleanup failed for ${draftId}`);
    }
  })();

  const url = buildPublishUrlPath(manifest.tier, manifest.scopeId, manifest.slug);
  logger.info(
    `[PUBLISH] finalize draft=${draftId} -> ${url} (bytes=${totalBytes}, files=${filesWithMeta.length}, overwrote=${!!previous})`
  );

  return {
    publicId: saved.publicId,
    url,
    tier: manifest.tier,
    scopeId: manifest.scopeId,
    slug: manifest.slug,
    visibility: manifest.visibility,
    publishedAt: now.toISOString(),
  };
}

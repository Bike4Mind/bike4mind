import { baseApi } from '@server/middlewares/baseApi';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import { PublishedArtifact } from '@bike4mind/database';
import {
  FinalizeRequestSchema,
  PUBLISH_LIMITS,
  type ArtifactFile,
  type PublishResult,
  type ValidationViolation,
} from '@bike4mind/common';
import {
  validateBundle,
  checkScopePermission,
  resolveVisibility,
  checkPublishQuota,
  buildPublishS3KeyPrefix,
  buildPublishUrlPath,
  invalidatePublishCdn,
  toCacheTarget,
  validateEmbedOrigins,
  buildReactArtifactBundle,
  UnsupportedReactDependencyError,
  ReactArtifactTranspileError,
  type PublishUser,
} from '@server/services/publish';

/**
 * POST /api/publish/artifact/finalize - step 3 of the 3-step publish flow.
 *
 * Reads the draft manifest, re-checks permission (defense in depth), verifies
 * every file exists + hashes it, runs validateBundle on index.html, promotes
 * the draft to its canonical key, and upserts the PublishedArtifact record
 * (overwrite-in-place; captures previousVersionMeta). Returns 200 with the URL,
 * or 422 with structured violations. Ported from Polaris Publish.
 */

const DraftManifestSchema = z.object({
  draftId: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  tier: z.enum(['user', 'project', 'organization']),
  scopeId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().optional(),
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
    // Raw JSX uploaded as index.html; transpiled to an inert bundle below (issue #21).
    artifactType: z.literal('react').optional(),
  }),
  files: z.array(z.object({ path: z.string(), size: z.number(), mimeType: z.string() })),
});
type DraftManifest = z.infer<typeof DraftManifestSchema>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const handler = baseApi().post(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = FinalizeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const { draftId } = parsed.data;
  if (!UUID_V4.test(draftId)) {
    return res.status(400).json({ error: 'Invalid draftId format' });
  }

  const draftPrefix = `drafts/${draftId}/`;
  const storage = getPublishedArtifactsStorage();

  // 1. Read draft manifest
  let manifest: DraftManifest;
  try {
    const buf = await storage.download(`${draftPrefix}_manifest.json`);
    const m = DraftManifestSchema.safeParse(JSON.parse(buf.toString('utf-8')));
    if (!m.success) {
      return res.status(404).json({ error: 'Draft not found or expired' });
    }
    manifest = m.data;
  } catch {
    return res.status(404).json({ error: 'Draft not found or expired' });
  }

  // 2. Re-check permission (defense in depth)
  if (manifest.createdBy !== String(req.user.id) && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You did not create this draft' });
  }
  const publishUser: PublishUser = {
    id: String(req.user.id),
    username: (req.user as { username?: string }).username,
    isAdmin: req.user.isAdmin,
    organizationId: req.user.organizationId ? String(req.user.organizationId) : null,
  };
  const perm = await checkScopePermission({ user: publishUser, tier: manifest.tier, scopeId: manifest.scopeId });
  if (!perm.ok) {
    return res.status(perm.status).json({ error: perm.error });
  }
  const viz = resolveVisibility(manifest.tier, manifest.visibility);
  if (!viz.ok || viz.visibility !== manifest.visibility) {
    return res.status(400).json({ error: 'Draft visibility is no longer valid for this scope' });
  }

  // 3. Verify every file exists + collect metadata
  type FileWithMeta = ArtifactFile;
  const filesWithMeta: FileWithMeta[] = [];
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
  if (violations.length > 0) {
    return res.status(422).json({ error: 'Validation failed', violations });
  }

  // 4. Locate index.html (required)
  const indexEntry = filesWithMeta.find(f => f.path === 'index.html');
  if (!indexEntry) {
    return res.status(422).json({
      error: 'Validation failed',
      violations: [{ type: 'missing_index', message: 'Bundle must contain an index.html at root' }],
    });
  }

  // 4a. React artifacts upload raw JSX as index.html; transpile it into a self-contained inert
  // HTML bundle here (issue #21) so the size caps, validateBundle, and promote below all operate
  // on the FINAL served bytes. Rejectable input (unsupported dep / bad JSX / multi-file) becomes
  // a clean 422 violation rather than a broken published page.
  if (manifest.source.artifactType === 'react') {
    try {
      const { indexHtml: bundled } = await buildReactArtifactBundle({
        source: bufferCache.get('index.html')!.toString('utf-8'),
        title: manifest.title,
      });
      const buf = Buffer.from(bundled, 'utf-8');
      bufferCache.set('index.html', buf);
      indexEntry.size = buf.length;
      indexEntry.sha256 = createHash('sha256').update(buf).digest('hex');
    } catch (err) {
      if (err instanceof UnsupportedReactDependencyError || err instanceof ReactArtifactTranspileError) {
        return res.status(422).json({
          error: 'Validation failed',
          violations: [{ type: 'forbidden_pattern', message: err.message, file: 'index.html' }],
        });
      }
      throw err;
    }
  }

  // 4b. Size caps (post-transpile, so a React bundle's FINAL size is what's enforced)
  const totalBytes = filesWithMeta.reduce((sum, f) => sum + f.size, 0);
  if (indexEntry.size > PUBLISH_LIMITS.maxFileBytes) {
    return res.status(422).json({
      error: 'Validation failed',
      violations: [
        {
          type: 'size_exceeded',
          message: `index.html (${indexEntry.size}B) exceeds per-file limit`,
          file: 'index.html',
        },
      ],
    });
  }
  if (totalBytes > PUBLISH_LIMITS.maxBundleBytes) {
    return res.status(422).json({
      error: 'Validation failed',
      violations: [{ type: 'size_exceeded', message: `Bundle total ${totalBytes}B exceeds cap` }],
    });
  }

  // 4c. Validate the (possibly transpiled) index.html
  const validation = validateBundle({
    indexHtml: bufferCache.get('index.html')!.toString('utf-8'),
    manifest: filesWithMeta.map(f => ({ path: f.path, mimeType: f.mimeType })),
  });
  if (!validation.valid) {
    return res.status(422).json({ error: 'Validation failed', violations: validation.violations });
  }

  // 4b. Cumulative per-owner quota re-check (defense in depth - the draft may
  // have been issued before other publishes consumed the allowance). Excludes
  // the {tier,scopeId,slug} being overwritten so a re-publish isn't double-counted.
  const quota = await checkPublishQuota({
    ownerId: String(req.user.id),
    orgScopeId: manifest.tier === 'organization' ? manifest.scopeId : null,
    isAdmin: req.user.isAdmin,
    incoming: { bytes: totalBytes, fileCount: filesWithMeta.length },
    replacing: { tier: manifest.tier, scopeId: manifest.scopeId, slug: manifest.slug },
  });
  if (!quota.ok) {
    return res.status(quota.status).json({ error: quota.error, code: quota.code, details: quota.details });
  }

  // 5. Previous version (overwrite-in-place forensics)
  const previous = await PublishedArtifact.findOne({
    tier: manifest.tier,
    scopeId: manifest.scopeId,
    slug: manifest.slug,
    deletedAt: null,
  })
    .select('publicId publishedAt ownerId lastPublishedBy size sha256Index versions accessGate')
    .lean<{
      publicId: string;
      publishedAt: Date;
      ownerId: string;
      lastPublishedBy?: string;
      size: { totalBytes: number; fileCount: number };
      sha256Index?: string;
      versions?: Array<{ sha256Index: string }>;
      accessGate?: unknown;
    } | null>();

  // Validate the embed allowlist against the artifact's FINAL open-public state. A
  // re-publish PRESERVES the previous access gate (it is not in the $set below), so
  // open-public means visibility public AND no preserved gate - matching the PATCH
  // path. Keeps validateEmbedOrigins' "fail loud" contract even for an API caller
  // that sends embedOrigins on the upload-url path against a gated artifact.
  const embed = validateEmbedOrigins(manifest.embedOrigins, {
    isOpenPublic: manifest.visibility === 'public' && !previous?.accessGate,
  });
  if (!embed.ok) {
    return res.status(400).json({ error: embed.error, code: embed.code });
  }

  // 6. Promote draft -> canonical prefix
  const canonicalPrefix = buildPublishS3KeyPrefix(manifest.tier, manifest.scopeId, manifest.slug);
  // Archive the prior canonical index.html before this overwrite so its bytes
  // survive in version history (served later via ?v={sha}). Best-effort.
  if (previous?.sha256Index) {
    try {
      const old = await storage.download(`${canonicalPrefix}index.html`);
      await storage.upload(old, `${canonicalPrefix}versions/${previous.sha256Index}.html`, {
        ContentType: 'text/html',
      });
    } catch {
      /* nothing to archive (first promote / missing prior) */
    }
  }
  for (const file of filesWithMeta) {
    await storage.upload(bufferCache.get(file.path)!, `${canonicalPrefix}${file.path}`, {
      ContentType: file.mimeType,
    });
  }
  bufferCache.clear();

  // 7. Upsert record
  const now = new Date();
  const publicId = previous?.publicId ?? uuidPublicId();
  // Version history (deduped by content sha): backfill the replaced version if
  // history doesn't record it, then add the new one unless it's an identical
  // re-publish (same sha). On first publish, `previous` is null -> [new] only.
  const haveShas = new Set((previous?.versions ?? []).map(v => v.sha256Index));
  const versionsToPush: Array<{
    publishedAt: Date;
    publishedBy: string;
    size: { totalBytes: number; fileCount: number };
    sha256Index: string;
  }> = [];
  if (previous?.sha256Index && !haveShas.has(previous.sha256Index)) {
    versionsToPush.push({
      publishedAt: previous.publishedAt,
      publishedBy: previous.lastPublishedBy ?? previous.ownerId,
      size: previous.size,
      sha256Index: previous.sha256Index,
    });
    haveShas.add(previous.sha256Index);
  }
  if (!haveShas.has(indexEntry.sha256)) {
    versionsToPush.push({
      publishedAt: now,
      publishedBy: String(req.user.id),
      size: { totalBytes, fileCount: filesWithMeta.length },
      sha256Index: indexEntry.sha256,
    });
  }
  const saved = await PublishedArtifact.findOneAndUpdate(
    { tier: manifest.tier, scopeId: manifest.scopeId, slug: manifest.slug, deletedAt: null },
    {
      $set: {
        publicId,
        title: manifest.title,
        description: manifest.description,
        visibility: manifest.visibility,
        gatedToGroupId: manifest.gatedToGroupId,
        commentPolicy: manifest.commentPolicy ?? 'none',
        // Like accessGate, the embed allowlist is managed post-publish via PATCH and
        // is NOT part of the normal publish payload. Only write a NON-EMPTY validated
        // list, so a plain re-publish (or an older client that defaults embedOrigins to
        // []) can only ADD grants here, never clobber an existing allowlist to [].
        // Clearing is done through the PATCH path.
        ...(embed.value.length > 0 ? { embedOrigins: embed.value } : {}),
        ownerId: previous ? previous.ownerId : String(req.user.id),
        lastPublishedBy: String(req.user.id),
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
      // Append this version to the history (oldest -> newest), deduped by content
      // sha and backfilling the replaced version if not yet recorded (an
      // identical re-publish must not duplicate a sha). Bytes for the current
      // entry live at index.html; older entries at versions/{sha}.html.
      $push: { versions: { $each: versionsToPush } },
    },
    { upsert: true, new: true }
  );

  // 7b. Re-publish overwrites the origin in place, but the public `/p/...` page is
  // CDN-cached (see serve route Cache-Control). Without invalidation the prior
  // version keeps serving for up to the TTL. Only public pages are cached
  // (gated pages are no-store), so skip the invalidation otherwise. Best-effort.
  if (saved.visibility === 'public') void invalidatePublishCdn(toCacheTarget(saved), req.logger);

  // 8. Best-effort draft cleanup
  void (async () => {
    try {
      for (const file of manifest.files) {
        await storage.delete(`${draftPrefix}${file.path}`).catch(() => undefined);
      }
      await storage.delete(`${draftPrefix}_manifest.json`).catch(() => undefined);
    } catch {
      req.logger.warn(`[PUBLISH] finalize: draft cleanup failed for ${draftId}`);
    }
  })();

  const url = buildPublishUrlPath(manifest.tier, manifest.scopeId, manifest.slug);
  req.logger.info(
    `[PUBLISH] finalize draft=${draftId} → ${url} (bytes=${totalBytes}, files=${filesWithMeta.length}, overwrote=${!!previous})`
  );

  const response: PublishResult = {
    publicId: saved.publicId,
    url,
    tier: manifest.tier,
    scopeId: manifest.scopeId,
    slug: manifest.slug,
    visibility: manifest.visibility,
    publishedAt: now.toISOString(),
  };
  return res.status(200).json(response);
});

/** Short public id for /p/r|f URLs (no nanoid dep in this package). */
function uuidPublicId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export const config = {
  api: { externalResolver: true },
};

export default handler;

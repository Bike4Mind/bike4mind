import { baseApi } from '@server/middlewares/baseApi';
import { v4 as uuidv4 } from 'uuid';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import {
  UploadUrlRequestSchema,
  PUBLISH_LIMITS,
  ALLOWED_MIME_PREFIXES,
  ALLOWED_MIME_EXACT,
  type UploadUrlResponse,
} from '@bike4mind/common';
import { checkScopePermission, resolveVisibility, checkPublishQuota, type PublishUser } from '@server/services/publish';

/**
 * POST /api/publish/artifact/upload-url - step 1 of the 3-step publish flow.
 *
 * Client posts {tier, scopeId, slug, files[]}; server validates scope/visibility/
 * files, writes a draft manifest to S3 under drafts/{draftId}/, and returns a
 * draftId + per-file presigned PUT URLs. The bytes then go directly to S3 (the
 * 3-step flow exists because Lambda caps sync request bodies far below 50MB
 * bundles). /finalize promotes the draft to its canonical key.
 *
 * Ported from Polaris Publish via the artifact-publishing blueprint.
 */

const PRESIGNED_URL_EXPIRY_SECONDS = 600; // 10 minutes

function isAllowedMime(mimeType: string): boolean {
  return ALLOWED_MIME_EXACT.includes(mimeType) || ALLOWED_MIME_PREFIXES.some(p => mimeType.startsWith(p));
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = UploadUrlRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const body = parsed.data;

  // ── File-level guardrails (count + size + MIME + single root index.html) ──
  if (body.files.length > PUBLISH_LIMITS.maxFiles) {
    return res.status(400).json({ error: `Too many files (max ${PUBLISH_LIMITS.maxFiles})` });
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
      return res.status(400).json({ error: `Invalid file path: ${f.path}` });
    }
    if (f.size > PUBLISH_LIMITS.maxFileBytes) {
      return res.status(400).json({ error: `File ${f.path} exceeds per-file limit` });
    }
    totalBytes += f.size;
    if (!isAllowedMime(f.mimeType)) {
      return res.status(400).json({ error: `Disallowed MIME type for ${f.path}: ${f.mimeType}` });
    }
  }
  if (totalBytes > PUBLISH_LIMITS.maxBundleBytes) {
    return res.status(400).json({ error: 'Bundle exceeds total size limit' });
  }
  const rootIndex = body.files.filter(f => f.path === 'index.html');
  if (rootIndex.length !== 1) {
    return res.status(400).json({ error: 'Bundle must contain exactly one index.html at the root' });
  }

  // ── Permission + visibility ──
  const publishUser: PublishUser = {
    id: String(req.user.id),
    username: (req.user as { username?: string }).username,
    isAdmin: req.user.isAdmin,
    organizationId: req.user.organizationId ? String(req.user.organizationId) : null,
  };
  const perm = await checkScopePermission({ user: publishUser, tier: body.tier, scopeId: body.scopeId });
  if (!perm.ok) {
    return res.status(perm.status).json({ error: perm.error });
  }
  const viz = resolveVisibility(body.tier, body.visibility);
  if (!viz.ok) {
    return res.status(400).json({ error: viz.error, code: viz.code });
  }

  // ── Cumulative per-owner quota (count + bytes) ──
  // Checked here so we reject before issuing presigned URLs (no wasted S3 PUTs).
  // A bundle publish targets a fixed {tier,scopeId,slug}: if a row already exists
  // there it's an in-place overwrite (exclude it from usage so it isn't double
  // counted); if not, excluding a non-existent key is a harmless no-op. So we can
  // pass `replacing` unconditionally here (unlike reply/fabfile, whose slug is
  // only known to be an overwrite after the source-reuse lookup).
  const quota = await checkPublishQuota({
    ownerId: String(req.user.id),
    orgScopeId: body.tier === 'organization' ? body.scopeId : null,
    isAdmin: req.user.isAdmin,
    incoming: { bytes: totalBytes, fileCount: body.files.length },
    replacing: { tier: body.tier, scopeId: body.scopeId, slug: body.slug },
  });
  if (!quota.ok) {
    return res.status(quota.status).json({ error: quota.error, code: quota.code, details: quota.details });
  }

  // ── Issue draft + presigned PUT URLs ──
  const draftId = uuidv4();
  const draftPrefix = `drafts/${draftId}/`;
  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  const draftManifest = {
    draftId,
    createdAt: new Date().toISOString(),
    createdBy: String(req.user.id),
    tier: body.tier,
    scopeId: body.scopeId,
    slug: body.slug,
    title: body.title,
    description: body.description,
    visibility: viz.visibility,
    gatedToGroupId: body.gatedToGroupId,
    commentPolicy: body.commentPolicy ?? 'none',
    source: body.source ?? { kind: 'bundle' as const },
    files: body.files,
  };

  const storage = getPublishedArtifactsStorage();
  await storage.upload(Buffer.from(JSON.stringify(draftManifest)), `${draftPrefix}_manifest.json`, {
    ContentType: 'application/json',
  });

  const uploadUrls: UploadUrlResponse['uploadUrls'] = await Promise.all(
    body.files.map(async file => {
      const url = await storage.getSignedUrl(`${draftPrefix}${file.path}`, 'put', {
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
        ContentType: file.mimeType,
      });
      return { path: file.path, url, expiresAt };
    })
  );

  req.logger.info(
    `[PUBLISH] upload-url draft=${draftId} ${body.tier}/${body.scopeId}/${body.slug} files=${body.files.length} user=${req.user.id}`
  );

  const response: UploadUrlResponse = { draftId, uploadUrls };
  return res.status(200).json(response);
});

export const config = {
  api: {
    externalResolver: true,
    bodyParser: { sizeLimit: '256kb' }, // metadata only — files go via presigned URLs
  },
};

export default handler;

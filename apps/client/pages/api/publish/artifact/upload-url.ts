import { baseApi } from '@server/middlewares/baseApi';
import { v4 as uuidv4 } from 'uuid';
import { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';
import { PublishedArtifact } from '@bike4mind/database';
import {
  UploadUrlRequestSchema,
  PUBLISH_LIMITS,
  ALLOWED_MIME_PREFIXES,
  ALLOWED_MIME_EXACT,
  type UploadUrlResponse,
  normalizePublishTags,
} from '@bike4mind/common';
import {
  checkScopePermission,
  resolveVisibility,
  archivedVersionBytes,
  checkPublishQuota,
  consumePublishAction,
  mintDraftUploadUrl,
  mayRepublishSlug,
  SLUG_OWNED_BY_OTHER,
  type PublishUser,
} from '@server/services/publish';

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
  if (existing && !mayRepublishSlug(existing.ownerId, publishUser)) {
    return res.status(403).json({ error: 'Only the owner can republish this slug', code: SLUG_OWNED_BY_OTHER });
  }

  // -- Cumulative per-owner storage quota (bytes only; there is no page-count cap) --
  // Checked here so we reject before issuing presigned URLs (no wasted S3 PUTs).
  // A bundle publish targets a fixed {tier,scopeId,slug}: if a row already exists
  // there it's an in-place overwrite (exclude it from usage so it isn't double
  // counted); if not, excluding a non-existent key is a harmless no-op. So we can
  // pass `replacing` unconditionally here (unlike reply/fabfile, whose slug is
  // only known to be an overwrite after the source-reuse lookup). The page's earlier
  // versions stay archived through the overwrite, so they are added back; whether the
  // current version gets archived too depends on the new bytes, which finalize checks.
  const quota = await checkPublishQuota({
    ownerId: String(req.user.id),
    orgScopeId: body.tier === 'organization' ? body.scopeId : null,
    isAdmin: req.user.isAdmin,
    incoming: {
      bytes: totalBytes,
      fileCount: body.files.length,
      archivedBytes: archivedVersionBytes(existing?.versions, existing?.sha256Index),
    },
    replacing: { tier: body.tier, scopeId: body.scopeId, slug: body.slug },
  });
  if (!quota.ok) {
    return res.status(quota.status).json({ error: quota.error, code: quota.code, details: quota.details });
  }

  // The daily publish allowance is counted here, once per bundle publish: finalize only promotes
  // the draft this issues, so it is not counted again. Throws a 429 when the allowance is used up.
  // If the draft then cannot be issued, no draft id reaches the caller, so the action is handed back.
  const action = await consumePublishAction(req.user);
  const refundAndRethrow = async (err: unknown): Promise<never> => {
    await action.refund();
    throw err;
  };

  // ── Issue draft + presigned PUT URLs ──
  const draftId = uuidv4();
  const draftPrefix = `drafts/${draftId}/`;
  const expiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000).toISOString();

  const draftTags = normalizePublishTags(body.tags ?? []);
  const draftManifest = {
    draftId,
    createdAt: new Date().toISOString(),
    createdBy: String(req.user.id),
    tier: body.tier,
    scopeId: body.scopeId,
    slug: body.slug,
    title: body.title,
    description: body.description,
    // Carried on the draft so finalize can write them with the artifact - one publish call sets the
    // tags, rather than the caller having to follow up with a PATCH. Normalize FIRST and only carry a
    // non-empty result, so neither `[]` nor `['  ']` travels as "clear the tags"; finalize guards
    // the same way.
    tags: draftTags.length ? draftTags : undefined,
    visibility: viz.visibility,
    gatedToGroupId: body.gatedToGroupId,
    commentPolicy: body.commentPolicy ?? 'none',
    // Carried through the draft; finalize applies the host/open-public rules once
    // the final visibility is settled (a new publish has no access gate yet).
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

  // Hosted -> presigned S3 PUT; self-host -> same-origin proxy URL (draftUploadUrl.ts).
  const uploadUrls: UploadUrlResponse['uploadUrls'] = await Promise.all(
    body.files.map(async file => {
      const url = await mintDraftUploadUrl({
        storage,
        key: `${draftPrefix}${file.path}`,
        draftId,
        path: file.path,
        mimeType: file.mimeType,
        size: file.size,
        expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
      });
      return { path: file.path, url, expiresAt };
    })
  ).catch(refundAndRethrow);

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

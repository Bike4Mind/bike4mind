import { baseApi } from '@server/middlewares/baseApi';
import { FabFile } from '@bike4mind/database';
import {
  PublishFabFileRequestSchema,
  SupportedFabFileMimeTypes,
  isImageServeable,
  type PublishResult,
} from '@bike4mind/common';
import { resolveVisibility, checkScopePermission, type PublishUser } from '@server/services/publish';
import { settlePublication } from '@server/services/publish/settlePublication';
import { getFilesStorage } from '@server/utils/storage';

/**
 * POST /api/publish/fabfile - publish a FabFile as a public viewer page at
 * /p/f/{publicId}. Snapshots the file's text body into the record so the serve
 * handler can render it without exposing the private FabFile. Re-publishing the
 * same file updates the owner's existing record in place (same publicId).
 */

// Mime types whose stored bytes ARE text-representable, so they can back a text viewer page. This
// is an allowlist (fail-closed): anything not listed - Office/PDF (need extraction), raster images
// (no text), or a future/unknown type - is treated as non-text so we never store decoded binary
// garbage. SVG is XML text, so its source is publishable as literal text.
const TEXT_MIME_TYPES = new Set<string>([
  SupportedFabFileMimeTypes.TXT_PLAIN,
  SupportedFabFileMimeTypes.TXT_MARKDOWN,
  SupportedFabFileMimeTypes.TXT_MD_LEGACY,
  SupportedFabFileMimeTypes.JSON,
  SupportedFabFileMimeTypes.HTML,
  SupportedFabFileMimeTypes.CSV,
  SupportedFabFileMimeTypes.XML,
  SupportedFabFileMimeTypes.SVG,
  SupportedFabFileMimeTypes.JS,
  SupportedFabFileMimeTypes.JSX,
  SupportedFabFileMimeTypes.TS,
  SupportedFabFileMimeTypes.TSX,
  SupportedFabFileMimeTypes.PY,
  SupportedFabFileMimeTypes.JAVA,
  SupportedFabFileMimeTypes.CPP,
  SupportedFabFileMimeTypes.CS,
  SupportedFabFileMimeTypes.PHP,
  SupportedFabFileMimeTypes.RUBY,
  SupportedFabFileMimeTypes.GO,
  SupportedFabFileMimeTypes.SWIFT,
  SupportedFabFileMimeTypes.KOTLIN,
  SupportedFabFileMimeTypes.RUST,
  SupportedFabFileMimeTypes.CSS,
  SupportedFabFileMimeTypes.LESS,
  SupportedFabFileMimeTypes.SASS,
  SupportedFabFileMimeTypes.SCSS,
  SupportedFabFileMimeTypes.YAML,
  SupportedFabFileMimeTypes.TOML,
  SupportedFabFileMimeTypes.SH,
  SupportedFabFileMimeTypes.BASH,
  SupportedFabFileMimeTypes.INI,
  SupportedFabFileMimeTypes.CONF,
]);

/**
 * Source the publishable text body for a fabfile. "Save as Text" / uploaded files keep their content
 * in S3 at `filePath`, not in `file.text` (which is often empty), so for text-representable types we
 * snapshot the S3 bytes and fall back to `file.text`. Non-text types (pdf/office/image or unknown)
 * have no text body for a viewer page - use already-extracted `file.text` if present, else reject.
 * Server analogue of the client `getContentFromFabfile`, minus the browser-only extractors/settings.
 */
async function sourceFabFileBody(file: {
  text?: string | null;
  mimeType?: string;
  filePath?: string;
}): Promise<{ ok: true; body: string } | { ok: false; status: number; error: string }> {
  const existingText = file.text?.trim() ? file.text : '';
  if (!file.mimeType || !TEXT_MIME_TYPES.has(file.mimeType)) {
    if (existingText) return { ok: true, body: existingText };
    return { ok: false, status: 415, error: `Cannot publish a ${file.mimeType ?? 'binary'} file as a viewer page` };
  }
  if (file.filePath) {
    try {
      const decoded = (await getFilesStorage().download(file.filePath)).toString('utf-8');
      // Only accept a non-empty object; a 0-byte/whitespace-only download falls through to
      // file.text (else 422) rather than publishing an empty <pre>. Returns the untrimmed body
      // so real content keeps its exact whitespace.
      if (decoded.trim()) return { ok: true, body: decoded };
    } catch {
      // Storage miss/expired object: fall through to any already-extracted text.
    }
  }
  if (existingText) return { ok: true, body: existingText };
  return { ok: false, status: 422, error: 'File has no readable content to publish' };
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = PublishFabFileRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const body = parsed.data;
  const userId = String(req.user.id);

  const file = await FabFile.findById(body.fabFileId)
    .select('userId fileName text mimeType filePath moderationStatus')
    .lean<{
      userId: string;
      fileName?: string;
      text?: string | null;
      mimeType?: string;
      filePath?: string;
      moderationStatus?: string | null;
    } | null>();
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (file.userId !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only publish your own files' });
  }
  // Hold-until-scanned: publishing serves the file's bytes on a public page, so never publish a
  // file that has not cleared moderation. isImageServeable is fail-closed on ALL mime types
  // (serveable only when moderationStatus === 'clean'), so this also covers a mislabeled image.
  if (!isImageServeable(file)) {
    const blocked = file.moderationStatus === 'blocked';
    return res.status(blocked ? 403 : 409).json({
      error: blocked
        ? 'This file was blocked by content moderation and cannot be published'
        : 'This file is still being scanned; try publishing again shortly',
    });
  }

  const tier = body.tier;
  const scopeId = body.scopeId ?? (tier === 'user' ? userId : '');
  if (!scopeId) {
    return res.status(400).json({ error: 'scopeId is required for non-user scopes' });
  }
  // Authorize the TARGET scope (not just source ownership) - prevents publishing
  // a file into another org's/project's scope. Mirrors upload-url.ts / finalize.ts.
  const publishUser: PublishUser = {
    id: userId,
    username: (req.user as { username?: string }).username,
    isAdmin: req.user.isAdmin,
    organizationId: req.user.organizationId ? String(req.user.organizationId) : null,
  };
  const perm = await checkScopePermission({ user: publishUser, tier, scopeId });
  if (!perm.ok) {
    return res.status(perm.status).json({ error: perm.error });
  }
  const viz = resolveVisibility(tier, body.visibility);
  if (!viz.ok) {
    return res.status(400).json({ error: viz.error, code: viz.code });
  }

  // Sourcing runs before the quota check (inside settlePublication) because quota needs the
  // sourced byte length. The whole object is read into memory here; acceptable since the caller
  // can only publish a file they own (checked above) - revisit if publish ever accepts files not
  // owned by the caller.
  const sourced = await sourceFabFileBody(file);
  if (!sourced.ok) {
    return res.status(sourced.status).json({ error: sourced.error });
  }

  // One publication per owner+file, rewritten in place on re-publish - see settlePublication.
  const settled = await settlePublication({
    ownerId: userId,
    isAdmin: req.user.isAdmin,
    source: { kind: 'fabfile', fabFileId: body.fabFileId },
    tier,
    scopeId,
    visibility: viz.visibility,
    title: body.title?.trim() || file.fileName || 'Shared file',
    renderedBody: sourced.body,
    logger: req.logger,
  });
  if (!settled.ok) {
    return res.status(settled.status).json(settled.body);
  }
  const { saved, slug, publishedAt } = settled;

  req.logger.info(`[PUBLISH] fabfile ${body.fabFileId} → /p/f/${saved.publicId}`);

  const response: PublishResult = {
    publicId: saved.publicId,
    url: `/p/f/${saved.publicId}`,
    tier,
    scopeId,
    slug,
    visibility: viz.visibility,
    publishedAt: publishedAt.toISOString(),
  };
  return res.status(200).json(response);
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

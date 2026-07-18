import { baseApi } from '@server/middlewares/baseApi';
import { getPublishedArtifactsStorage } from '@server/utils/storage';
import { PUBLISH_LIMITS } from '@bike4mind/common';
import { verifyDraftUploadToken } from '@server/services/publish';

/**
 * PUT /api/publish/artifact/draft-upload - SELF-HOST proxy for step 2 of the
 * 3-step publish flow. Hosted deployments PUT bundle bytes straight to S3 via a
 * presigned URL; self-host has no browser-reachable object store, so the app
 * proxies the upload: the browser PUTs the raw file bytes here and the server
 * streams them into storage under the same `drafts/{draftId}/{path}` key that
 * finalize.ts reads. Mint decides which URL the browser gets (draftUploadUrl.ts).
 *
 * Anonymous by design - the signed capability token IS the auth (same posture as
 * the presigned URL it replaces). The token pins {draftId, path}; we upload only
 * to the claim's key, so a tampered query string cannot redirect the write.
 * Inert (404) unless B4M_SELF_HOST is set, so it adds no surface to hosted stages.
 *
 * bodyParser is disabled so the raw file bytes reach us unparsed; we cap the
 * stream at the per-file limit (defense in depth over the Content-Length guard
 * in baseApi, which a lying header could understate).
 */

/** Headroom over the raw per-file cap for request framing/overhead in the
 *  Content-Length guard; the streaming cap below still enforces the byte limit. */
const UPLOAD_BODY_MARGIN_BYTES = 64 * 1024;

/** Draft ids are uuid v4 (see upload-url.ts); keep this in sync with finalize.ts's
 *  validation so the same namespace is enforced on both sides of the flow. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const handler = baseApi({ auth: false, maxBodySize: PUBLISH_LIMITS.maxFileBytes + UPLOAD_BODY_MARGIN_BYTES }).put(
  async (req, res) => {
    if (process.env.B4M_SELF_HOST !== 'true') {
      return res.status(404).json({ error: 'Not found' });
    }

    // A well-formed mint URL carries exactly one string `token`; anything else
    // (missing, repeated, or a nested query object) is malformed -> reject.
    const token = typeof req.query.token === 'string' ? req.query.token : undefined;
    if (!token) {
      return res.status(401).json({ error: 'Missing upload token' });
    }
    const claims = verifyDraftUploadToken(token);
    if (!claims) {
      return res.status(401).json({ error: 'Invalid or expired upload token' });
    }

    // Path hygiene mirrors upload-url.ts (the token was minted from an
    // already-validated manifest path, so this is defense in depth): no
    // traversal, no absolute/backslash paths, no control chars, and never the
    // reserved server-written draft manifest.
    const { draftId, path } = claims;
    // Validate the draftId claim before interpolating it into the storage key
    // (mirrors finalize.ts), so a malformed id can never widen the key namespace.
    if (!UUID_V4.test(draftId)) {
      return res.status(400).json({ error: 'Invalid draftId' });
    }
    if (
      path.includes('..') ||
      path.startsWith('/') ||
      path.includes('\\') ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/.test(path) ||
      path === '_manifest.json'
    ) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    // Stream the raw body, enforcing the per-file byte cap as we go.
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > PUBLISH_LIMITS.maxFileBytes) {
        return res.status(413).json({ error: 'File exceeds per-file limit' });
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks, total);

    const headerContentType = req.headers['content-type'];
    const contentType = typeof headerContentType === 'string' ? headerContentType.split(';')[0].trim() : undefined;

    const storage = getPublishedArtifactsStorage();
    await storage.upload(body, `drafts/${draftId}/${path}`, contentType ? { ContentType: contentType } : undefined);

    req.logger.info(`[PUBLISH] draft-upload draft=${draftId} path=${path} bytes=${total}`);
    return res.status(200).json({ ok: true });
  }
);

export const config = {
  api: {
    externalResolver: true,
    bodyParser: false, // raw bytes streamed to storage; see the streaming cap above
  },
};

export default handler;

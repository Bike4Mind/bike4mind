import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { HTTPError } from '@bike4mind/server-utils/utils/errors';
import type { Response } from 'express';
import { CreateAnnotationRequestSchema, type ListAnnotationsResponse } from '@bike4mind/common';
import { requestHasGateProof } from '@server/services/publish';
import { createAnnotation, listAnnotations } from '@server/services/publish/annotations';

/**
 * /api/publish/annotations/[publicId] - the collaboration layer for a published
 * artifact (Phase A of the artifact-collab layer).
 *
 *   GET  -> list annotations (visibility-gated read; anonymous on public artifacts)
 *   POST -> create an annotation (requires auth + the artifact's commentPolicy)
 *
 * Uses baseApi({ auth: false }) + optionalAuth so anonymous viewers can READ a
 * public artifact's comments; writes additionally require req.user. v1 accepts
 * only `comment`-kind annotations (approval/vote/signature reserved for Phase D).
 */

const listRateLimit = rateLimit({ limit: 120, windowMs: 60_000, bucket: 'publish-annotations-list' });

/** Maps a service's typed HTTP error to the legacy `{ error }` body; anything else is a real failure. */
function sendServiceError(res: Response, error: unknown) {
  if (error instanceof HTTPError) return res.status(error.statusCode).json({ error: error.message });
  throw error;
}

const handler = baseApi({ auth: false })
  .use(optionalAuth)
  .use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.setHeader('Cache-Control', 'private, no-store');
    return listRateLimit(req, res, next);
  })
  .get(async (req, res) => {
    // Default every response (incl. 400/401/403/404) to no-store BEFORE the gate,
    // so a cached error can't poison subsequent authorized reads on the shared,
    // auth-insensitive cache key. Only the public 200 below opts INTO caching.
    res.setHeader('Cache-Control', 'private, no-store');

    const publicId = String(req.query.publicId ?? '');
    if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

    let listed;
    try {
      listed = await listAnnotations({ user: req.user, publicId, hasGateProof: requestHasGateProof(req, publicId) });
    } catch (error) {
      return sendServiceError(res, error);
    }

    const response: ListAnnotationsResponse = { annotations: listed.annotations, commentPolicy: listed.commentPolicy };
    // The list is identical for everyone who can view, so PUBLIC artifacts are
    // CDN-cacheable - this collapses the widget's polling fan-out across viewers.
    // Per-viewer `canComment` is served separately (.../can-comment) so it never
    // pollutes this shared, cacheable body. Non-public stays no-store.
    //
    // INVARIANT - this body MUST stay viewer-invariant. It is served from a shared
    // CDN cache key that does not vary on Authorization, so ANY per-viewer field
    // added here would leak across viewers. Per-viewer data belongs in /can-comment.
    // Only OPEN-public (ungated) may be shared-cached: a gated artifact's list is
    // authorized per viewer, so it keeps the no-store default even though its
    // visibility is still 'public'.
    // No stale-while-revalidate: it let a viewer who had just commented be served the
    // pre-comment body for up to a further 60s, so a fresh comment appeared to vanish
    // on reload. A short shared TTL still collapses the polling fan-out. The widget
    // additionally sends `cache: 'no-store'` on its FIRST load for the same reason.
    if (listed.cacheable) {
      res.setHeader('Cache-Control', 'public, max-age=5, s-maxage=5');
    }
    return res.status(200).json(response);
  })
  .post(async (req, res) => {
    if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

    const publicId = String(req.query.publicId ?? '');
    if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

    const parsed = CreateAnnotationRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const input = parsed.data;
    try {
      const created = await createAnnotation({
        user: req.user,
        publicId,
        input,
        logger: req.logger,
        hasGateProof: requestHasGateProof(req, publicId),
      });
      return res.status(201).json(created);
    } catch (error) {
      return sendServiceError(res, error);
    }
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } },
};

export default handler;

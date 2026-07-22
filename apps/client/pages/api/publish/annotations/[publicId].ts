import { baseApi } from '@server/middlewares/baseApi';
import { optionalAuth } from '@server/middlewares/optionalAuth';
import type { Request } from 'express';
import { Annotation, PublishedArtifact } from '@bike4mind/database';
import {
  CreateAnnotationRequestSchema,
  type CommentPolicy,
  type ListAnnotationsResponse,
  type PublishVisibility,
} from '@bike4mind/common';
import {
  checkVisibility,
  canAnnotate,
  toPublishUser,
  authorDisplayName,
  toAnnotationDto,
  requestHasGateProof,
  type AnnotationLean,
} from '@server/services/publish';

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

/** Per-author comment throttle (anti-spam) - see the write handler. */
const COMMENT_RATE_WINDOW_MS = 60_000;
const COMMENT_RATE_MAX = 30;

interface ArtifactGateLean {
  publicId: string;
  visibility: PublishVisibility;
  ownerId: string;
  scopeId: string;
  commentPolicy: CommentPolicy;
  sha256Index?: string;
  // Required (explicit null) to match VisibilityCheckArtifact - the gate is
  // enforced off this field, so normalizing it here means no caller can pass a
  // shape that silently bypasses the gate. A lean read of a pre-gate doc may
  // omit it, so loadArtifact coerces `?? null`.
  accessGate: { kind: 'passphrase' | 'domain'; allowedDomains?: string[] } | null;
}

async function loadArtifact(publicId: string): Promise<ArtifactGateLean | null> {
  const doc = await PublishedArtifact.findOne({ publicId, deletedAt: null })
    .select('publicId visibility ownerId scopeId commentPolicy sha256Index accessGate')
    .lean<Omit<ArtifactGateLean, 'accessGate'> & { accessGate?: ArtifactGateLean['accessGate'] }>();
  return doc ? { ...doc, accessGate: doc.accessGate ?? null } : null;
}

/** The gate context for annotation reads/writes: a passphrase gate is satisfied
 *  by the per-artifact proof cookie the viewer already holds from unlocking the
 *  page (annotation requests are same-origin, so the cookie rides along). */
function gateContext(req: Request, artifact: ArtifactGateLean) {
  return {
    passphraseVerified: artifact.accessGate?.kind === 'passphrase' && requestHasGateProof(req, artifact.publicId),
  };
}

/** Open-public = public AND ungated: the only state whose annotation list may be
 *  served from the shared CDN cache. A gated artifact's list is per-viewer-gated,
 *  so it must stay no-store even though its visibility is still 'public'. */
const isOpenPublic = (a: ArtifactGateLean) => a.visibility === 'public' && !a.accessGate;

const handler = baseApi({ auth: false })
  .use(optionalAuth)
  .get(async (req, res) => {
    // Default every response (incl. 400/401/403/404) to no-store BEFORE the gate,
    // so a cached error can't poison subsequent authorized reads on the shared,
    // auth-insensitive cache key. Only the public 200 below opts INTO caching.
    res.setHeader('Cache-Control', 'private, no-store');

    const publicId = String(req.query.publicId ?? '');
    if (!publicId) return res.status(400).json({ error: 'Missing publicId' });

    const artifact = await loadArtifact(publicId);
    if (!artifact) return res.status(404).json({ error: 'Not found' });

    const publishUser = toPublishUser(req.user);
    const vis = await checkVisibility(artifact, publishUser, gateContext(req, artifact));
    if (!vis.ok) return res.status(vis.status).json({ error: vis.error });

    const rows = await Annotation.find({ publicId, deletedAt: null }).sort({ createdAt: 1 }).lean<AnnotationLean[]>();

    const response: ListAnnotationsResponse = {
      annotations: rows.map(toAnnotationDto),
      commentPolicy: artifact.commentPolicy,
    };
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
    if (isOpenPublic(artifact)) {
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
    // v1 ships comments only; reserved kinds are rejected (not silently coerced).
    if (input.kind && input.kind !== 'comment') {
      return res.status(400).json({ error: 'Only comment annotations are supported in this version' });
    }

    const artifact = await loadArtifact(publicId);
    if (!artifact) return res.status(404).json({ error: 'Not found' });

    const publishUser = toPublishUser(req.user);
    const vis = await checkVisibility(artifact, publishUser, gateContext(req, artifact));
    if (!vis.ok) return res.status(vis.status).json({ error: vis.error });

    if (!canAnnotate(artifact, publishUser, true)) {
      const why =
        artifact.commentPolicy === 'none' ? 'Commenting is disabled for this artifact' : 'Not authorized to comment';
      return res.status(403).json({ error: why });
    }

    // Anti-spam throttle. These routes run under baseApi({ auth: false }) and so
    // bypass the API-key rate-limit stack; this per-author window applies to ALL
    // callers (JWT or key) regardless of auth type. Admins are exempt.
    if (!req.user.isAdmin) {
      const recent = await Annotation.countDocuments({
        authorId: String(req.user.id),
        createdAt: { $gte: new Date(Date.now() - COMMENT_RATE_WINDOW_MS) },
      });
      if (recent >= COMMENT_RATE_MAX) {
        return res.status(429).json({ error: 'You are commenting too quickly - please slow down' });
      }
    }

    // Thread integrity: a reply must target a live annotation on the SAME artifact.
    if (input.threadRootId) {
      const root = await Annotation.findOne({ _id: input.threadRootId, publicId, deletedAt: null })
        .select('_id')
        .lean<{ _id: unknown } | null>();
      if (!root)
        return res.status(400).json({ error: 'threadRootId does not reference an annotation on this artifact' });
    }

    const created = await Annotation.create({
      publicId,
      // Pin to the artifact's CURRENT version, not a client-supplied value.
      artifactVersionSha: artifact.sha256Index,
      kind: 'comment',
      authorId: String(req.user.id),
      authorDisplayName: authorDisplayName(req.user),
      body: input.body,
      anchor: input.anchor,
      threadRootId: input.threadRootId ?? null,
    });

    req.logger.info(`[ANNOTATE] create publicId=${publicId} by=${req.user.id} id=${created.id}`);
    return res.status(201).json(toAnnotationDto(created.toObject() as unknown as AnnotationLean));
  });

export const config = {
  api: { externalResolver: true, bodyParser: { sizeLimit: '64kb' } },
};

export default handler;

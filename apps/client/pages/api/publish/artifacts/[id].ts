import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import {
  VisibilitySchema,
  CommentPolicySchema,
  EMBED_ORIGINS_MAX,
  PublishTagsSchema,
  ApiKeyScope,
} from '@bike4mind/common';
import {
  deletePublishedPage,
  getPublishedPage,
  isManagePublishedPageError,
  toLegacyErrorBody,
  updatePublishedPage,
} from '@server/services/publish/managePublishedPages';

/**
 * /api/publish/artifacts/[id] - manage one published artifact by its publicId.
 *   GET    -> management metadata (owner/admin) or public display fields
 *   PATCH  -> update title/description/visibility/commentPolicy (owner/admin)
 *   DELETE -> soft-delete / archive (owner/admin)
 */

/** Syntactic domain check: labels + a real TLD, lowercase-normalized before test.
 *  A pre-filter only - entries are then validated as real registrable domains below
 *  and stored AS ENTERED (never reduced); matching is exact-or-subdomain. */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Access gate on top of an ENFORCING surface (issue #383). The passphrase arrives
 * in plaintext ONCE here and is bcrypt-hashed before it touches the document;
 * `null` clears the gate. Valid while visibility is public OR while an active
 * share token exists - see the surface check in the PATCH handler below.
 */
const AccessGatePatchSchema = z.union([
  z.object({
    kind: z.literal('passphrase'),
    passphrase: z.string().min(8, 'Passphrase must be at least 8 characters').max(128),
  }),
  z.object({
    kind: z.literal('domain'),
    allowedDomains: z
      .array(z.string().trim().toLowerCase().pipe(z.string().regex(DOMAIN_RE, 'Invalid domain')))
      .min(1)
      .max(20),
  }),
  z.null(),
]);

const PatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  // Full replace, not a merge: `[]` clears every tag. A merge semantics would leave no way to
  // REMOVE a tag through the API, which is half of the CRUD the owner needs.
  tags: PublishTagsSchema.optional(),
  visibility: VisibilitySchema.optional(),
  commentPolicy: CommentPolicySchema.optional(),
  // Search-engine opt-in. Accepted at any visibility (owners commonly set it before
  // flipping to public), but only has an effect while the artifact is open-public -
  // the serve route ANDs it with isOpenPublic on every request.
  discoverable: z.boolean().optional(),
  accessGate: AccessGatePatchSchema.optional(),
  // Raw strings; validateEmbedOrigins normalizes and applies the host/open-public
  // rules server-side. `[]` clears the allowlist. Bounded here so a huge payload
  // is rejected before per-origin parsing.
  embedOrigins: z.array(z.string()).max(EMBED_ORIGINS_MAX).optional(),
});

// Public viewers (anyone hitting a `visibility: 'public'` artifact) get only these
// display fields. Everything else -- ownerId, lastPublishedBy, storageKeyPrefix,
// moderation internals (reportCount/takedownReason/deletedBy/moderationStatus),
// source, tier/scopeId/slug, manifest/renderedBody, etc. -- is owner/admin-only.
//
// `tags` travels to public viewers DELIBERATELY, matching what the list route already projects on
// its non-`mine` branch: they are artifact metadata in the same class as title and description,
// which are on this path too, and a public browse surface will want to filter on them. So an owner
// labelling a public artifact is publishing that label - nothing in the tag editor claims
// otherwise, and it must not start to. (The owner-scoped property belongs to the VOCABULARY
// endpoint, GET /api/publish/tags, which reads only the caller's own id; it never described tags on
// an artifact document.)
const PUBLIC_ARTIFACT_FIELDS = [
  'publicId',
  'title',
  'description',
  'tags',
  'visibility',
  'commentPolicy',
  'embedOrigins',
  'publishedAt',
] as const;

function toPublicArtifact(artifact: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of PUBLIC_ARTIFACT_FIELDS) {
    if (artifact[field] !== undefined) out[field] = artifact[field];
  }
  return out;
}

const handler = baseApi({
  requiredScopes: [ApiKeyScope.ARTIFACTS_PUBLISH, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
})
  .get(async (req, res) => {
    try {
      const { artifact, isManager } = await getPublishedPage({ user: req.user, publicId: String(req.query.id) });
      // Owner/admin keep the metadata needed by the manage modal; other viewers of an ungated
      // public artifact get only the public display DTO.
      return res.status(200).json({ artifact: isManager ? artifact : toPublicArtifact(artifact) });
    } catch (error) {
      if (isManagePublishedPageError(error)) return res.status(error.statusCode).json(toLegacyErrorBody(error));
      throw error;
    }
  })
  .patch(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    try {
      const artifact = await updatePublishedPage({
        user: req.user,
        logger: req.logger,
        publicId: String(req.query.id),
        patch: parsed.data,
        request: req,
      });
      return res.status(200).json({ artifact });
    } catch (error) {
      if (isManagePublishedPageError(error)) return res.status(error.statusCode).json(toLegacyErrorBody(error));
      throw error;
    }
  })
  .delete(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    try {
      await deletePublishedPage({ user: req.user, logger: req.logger, publicId: String(req.query.id) });
      return res.status(200).json({ ok: true });
    } catch (error) {
      if (isManagePublishedPageError(error)) return res.status(error.statusCode).json(toLegacyErrorBody(error));
      throw error;
    }
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

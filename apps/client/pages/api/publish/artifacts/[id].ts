import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { PublishedArtifact } from '@bike4mind/database';
import { VisibilitySchema, CommentPolicySchema, EMBED_ORIGINS_MAX } from '@bike4mind/common';
import { resolveVisibility, invalidatePublishCdn, toCacheTarget, validateEmbedOrigins } from '@server/services/publish';
import { registrableDomain } from '@bike4mind/utils/registrableDomain';

/**
 * /api/publish/artifacts/[id] - manage one published artifact by its publicId.
 *   GET    -> full record (owner/admin, or anyone if public)
 *   PATCH  -> update title/description/visibility/commentPolicy (owner/admin)
 *   DELETE -> soft-delete / archive (owner/admin)
 */

/** Syntactic domain check: labels + a real TLD, lowercase-normalized before test.
 *  A pre-filter only - entries are then reduced to their registrable domain (eTLD+1)
 *  below, which is what actually gets stored and matched. */
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Access gate on top of `visibility: 'public'` (issue #383). The passphrase
 * arrives in plaintext ONCE here and is bcrypt-hashed before it touches the
 * document; `null` clears the gate. Only valid while visibility is public.
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
  visibility: VisibilitySchema.optional(),
  commentPolicy: CommentPolicySchema.optional(),
  accessGate: AccessGatePatchSchema.optional(),
  // Raw strings; validateEmbedOrigins normalizes and applies the host/open-public
  // rules server-side. `[]` clears the allowlist. Bounded here so a huge payload
  // is rejected before per-origin parsing.
  embedOrigins: z.array(z.string()).max(EMBED_ORIGINS_MAX).optional(),
});

function canManage(artifact: { ownerId: string }, user: { id: string; isAdmin?: boolean }): boolean {
  return artifact.ownerId === String(user.id) || !!user.isAdmin;
}

const handler = baseApi()
  .get(async (req, res) => {
    const publicId = String(req.query.id);
    // Exclude the share-token capability: this GET is reachable by ANY viewer of a public
    // artifact, and .lean() bypasses the schema's toJSON strip - so project it out here.
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null })
      .select('-shareToken -shareTokenUpdatedAt')
      .lean<{
        ownerId: string;
        visibility: string;
      } | null>();
    if (!artifact) {
      return res.status(404).json({ error: 'Artifact not found' });
    }
    // Non-public artifacts require an owner/admin viewer on this management route.
    if (artifact.visibility !== 'public') {
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });
      if (!canManage(artifact, req.user)) {
        return res.status(403).json({ error: 'Not authorized to view this artifact' });
      }
    }
    return res.status(200).json({ artifact });
  })
  .patch(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const publicId = String(req.query.id);
    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
    }
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    if (!canManage(artifact, req.user)) {
      return res.status(403).json({ error: 'Not authorized to update this artifact' });
    }
    if (parsed.data.title !== undefined) artifact.title = parsed.data.title;
    if (parsed.data.description !== undefined) artifact.description = parsed.data.description;
    // "Open public" = cacheable, anonymous, ungated. Adding a gate to a public
    // artifact leaves `visibility` alone but must still purge the CDN, so track
    // the gate in the before/after comparison, not just the visibility level.
    const wasOpenPublic = artifact.visibility === 'public' && !artifact.accessGate;
    if (parsed.data.visibility !== undefined) {
      // Validate the requested visibility against the artifact's scope-tier policy
      // (same rules as publish) so PATCH can't set a tier-invalid visibility.
      const viz = resolveVisibility(artifact.tier, parsed.data.visibility);
      if (!viz.ok) {
        return res.status(400).json({ error: viz.error, code: viz.code });
      }
      artifact.visibility = parsed.data.visibility;
    }
    if (parsed.data.accessGate !== undefined) {
      if (parsed.data.accessGate === null) {
        artifact.accessGate = null;
      } else if (parsed.data.accessGate.kind === 'passphrase') {
        artifact.accessGate = {
          kind: 'passphrase',
          passphraseHash: await bcrypt.hash(parsed.data.accessGate.passphrase, 10),
        };
      } else {
        // Validate each entry is a real registrable domain (rejects a bare public/
        // private suffix like co.uk or github.io that would admit an entire suffix),
        // but STORE IT AS ENTERED - never reduce to the registrable domain. Reducing
        // e.g. `acme.onmicrosoft.com` to the shared `onmicrosoft.com` would let every
        // other tenant in; matching is exact-or-subdomain against the stored entry.
        const entries = parsed.data.accessGate.allowedDomains.map(d => d.trim().toLowerCase());
        if (entries.some(d => registrableDomain(d, { allowPrivateDomains: true }) === null)) {
          return res.status(400).json({
            error:
              'Each allowed domain must be a registrable domain (e.g. acme.com or a specific subdomain), not a public suffix like co.uk',
            code: 'INVALID_DOMAIN',
          });
        }
        artifact.accessGate = {
          kind: 'domain',
          allowedDomains: [...new Set(entries)],
        };
      }
    }
    // A gate only means something on the public tier - reject a combination that
    // would silently never apply (fail loud beats a gate the owner thinks is on).
    if (artifact.accessGate && artifact.visibility !== 'public') {
      return res.status(400).json({
        error: 'An access gate requires visibility "public" - clear the gate or set visibility to public',
        code: 'GATE_REQUIRES_PUBLIC',
      });
    }
    if (parsed.data.commentPolicy !== undefined) artifact.commentPolicy = parsed.data.commentPolicy;

    // Embed allowlist. Validated against the artifact's FINAL open-public state
    // (after any visibility/gate change above), so a gate + embed grant in the
    // same PATCH is rejected as a pair rather than by apply order.
    const isOpenPublicNow = artifact.visibility === 'public' && !artifact.accessGate;
    let embedOriginsChanged = false;
    if (parsed.data.embedOrigins !== undefined) {
      const check = validateEmbedOrigins(parsed.data.embedOrigins, { isOpenPublic: isOpenPublicNow });
      if (!check.ok) {
        return res.status(400).json({ error: check.error, code: check.code });
      }
      const before = [...(artifact.embedOrigins ?? [])].sort();
      const after = [...check.value].sort();
      embedOriginsChanged = before.join('\n') !== after.join('\n');
      // Absent (undefined) when empty so the field stays off the document.
      artifact.embedOrigins = check.value.length > 0 ? check.value : undefined;
    }
    await artifact.save();

    // Any change that alters the CACHED public response must purge the CDN, or the
    // stale copy keeps serving up to its TTL. Two triggers: (a) leaving open-public
    // (downgrade OR newly-gated) removes the page from cache-eligibility; (b) the
    // embed allowlist changed while still open-public - the served frame-ancestors
    // CSP header is part of the cached bytes. Fire-and-forget, best-effort.
    if ((wasOpenPublic && !isOpenPublicNow) || (isOpenPublicNow && embedOriginsChanged)) {
      void invalidatePublishCdn(toCacheTarget(artifact), req.logger);
    }
    const json = artifact.toJSON() as Record<string, unknown> & {
      accessGate?: { passphraseHash?: string | null } | null;
    };
    // Defense in depth: the hash is select:false, but this doc was loaded in this
    // request's write path - never echo it.
    if (json.accessGate && 'passphraseHash' in json.accessGate) delete json.accessGate.passphraseHash;
    return res.status(200).json({ artifact: json });
  })
  .delete(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    const publicId = String(req.query.id);
    const artifact = await PublishedArtifact.findOne({ publicId, deletedAt: null });
    if (!artifact) return res.status(404).json({ error: 'Artifact not found' });
    if (!canManage(artifact, req.user)) {
      return res.status(403).json({ error: 'Not authorized to delete this artifact' });
    }
    const wasPublic = artifact.visibility === 'public';
    await artifact.softDelete(String(req.user.id));
    // Purge the CDN so a deleted public page stops serving from cache immediately
    // (fire-and-forget - best-effort, never blocks the delete).
    if (wasPublic) {
      void invalidatePublishCdn(toCacheTarget(artifact), req.logger);
    }
    return res.status(200).json({ ok: true });
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { randomUUID } from 'node:crypto';
import { Quest, PublishedArtifact } from '@bike4mind/database';
import { PublishReplyRequestSchema, type PublishResult } from '@bike4mind/common';
import { resolveVisibility, checkScopePermission, checkPublishQuota, type PublishUser } from '@server/services/publish';
import { parseArtifactsWithFallback } from '@client/app/utils/artifactParser';

/**
 * POST /api/publish/reply - publish a single assistant reply as a public viewer
 * page. Unlike bundles, replies skip the upload->S3->finalize dance: we snapshot
 * the reply markdown into the record (renderedBody) and serve it server-side at
 * /p/r/{publicId}. Re-publishing the same message returns the existing publicId.
 */

function publicId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Extract the assistant reply as markdown, mirroring the client's extractReplies:
 * prefer the `replies[]` array (the server streams into it), fall back to the flat
 * `reply`, then to text blocks in `structuredReplies`. Strips `<think>...</think>`.
 */
function extractReplyMarkdown(quest: {
  reply?: string | null;
  replies?: string[] | null;
  structuredReplies?: Array<{ content?: unknown }> | null;
}): string {
  const parts =
    Array.isArray(quest.replies) && quest.replies.length > 0 ? quest.replies : quest.reply ? [quest.reply] : [];

  const out: string[] = [];
  for (const part of parts) {
    if (!part || !part.trim()) continue;
    let cleaned = part;
    if (cleaned.includes('<think>') && cleaned.includes('</think>')) {
      cleaned = cleaned.slice(cleaned.lastIndexOf('</think>') + '</think>'.length).trim();
    } else if (cleaned.startsWith('<think>')) {
      cleaned = '';
    }
    if (cleaned) out.push(cleaned);
  }
  let combined = out.join('').trim();

  // Fallback: flatten text blocks from structuredReplies (tool-use / thinking format).
  if (!combined && Array.isArray(quest.structuredReplies)) {
    combined = quest.structuredReplies
      .flatMap(sr => (Array.isArray(sr?.content) ? sr.content : []))
      .map(block => {
        if (typeof block === 'string') return block;
        const b = block as { type?: string; text?: string };
        return b?.text ?? '';
      })
      .join('')
      .trim();
  }
  return combined;
}

const handler = baseApi().post(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const parsed = PublishReplyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues });
  }
  const body = parsed.data;
  const userId = String(req.user.id);

  // Load the message (a Quest) and verify ownership. The streamed answer lives in
  // `replies[]` (authoritative), falling back to the flat `reply`, then to text
  // blocks in `structuredReplies` - mirror the UI's extractReplies so a published
  // reply matches what the user sees on screen.
  const quest = await Quest.findOne({ _id: body.messageId, sessionId: body.sessionId })
    .select('userId reply replies structuredReplies')
    .lean<{
      userId: string;
      reply?: string | null;
      replies?: string[] | null;
      structuredReplies?: Array<{ content?: unknown }> | null;
    } | null>();
  if (!quest) {
    return res.status(404).json({ error: 'Reply not found' });
  }
  if (quest.userId !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'You can only publish your own replies' });
  }
  const markdown = extractReplyMarkdown(quest);
  if (!markdown) {
    return res.status(400).json({ error: 'This message has no reply content to publish' });
  }

  // user tier defaults to the caller's own scope.
  const tier = body.tier;
  const scopeId = body.scopeId ?? (tier === 'user' ? userId : '');
  if (!scopeId) {
    return res.status(400).json({ error: 'scopeId is required for non-user scopes' });
  }
  // Authorize the TARGET scope - not just source ownership - so a user can't
  // publish their own reply into another org's/project's scope (cross-scope
  // content injection). Mirrors upload-url.ts / finalize.ts.
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

  // Reuse an existing publication of the same message IN THE SAME SCOPE if
  // present. Scoping by tier+scopeId avoids minting a duplicate publicId when
  // the same reply is published into a different scope (which must be a new row).
  const existing = await PublishedArtifact.findOne({
    tier,
    scopeId,
    'source.kind': 'reply',
    'source.sessionId': body.sessionId,
    'source.messageId': body.messageId,
    deletedAt: null,
  }).lean<{ publicId: string; slug: string } | null>();

  const id = existing?.publicId ?? publicId();
  const slug = existing?.slug ?? `r-${id}`;

  // Cumulative per-owner quota. Re-publishing the same reply (existing) overwrites
  // in place, so exclude that key from usage; a fresh publish counts as a new row.
  const quota = await checkPublishQuota({
    ownerId: userId,
    orgScopeId: tier === 'organization' ? scopeId : null,
    isAdmin: req.user.isAdmin,
    incoming: { bytes: Buffer.byteLength(markdown), fileCount: 0 },
    replacing: existing ? { tier, scopeId, slug } : null,
  });
  if (!quota.ok) {
    return res.status(quota.status).json({ error: quota.error, code: quota.code, details: quota.details });
  }

  const title = body.title?.trim() || deriveTitle(markdown);
  const now = new Date();

  const saved = await PublishedArtifact.findOneAndUpdate(
    { tier, scopeId, slug, deletedAt: null },
    {
      $set: {
        publicId: id,
        title,
        visibility: viz.visibility,
        lastPublishedBy: userId,
        source: { kind: 'reply', sessionId: body.sessionId, messageId: body.messageId },
        storageKeyPrefix: '',
        size: { totalBytes: Buffer.byteLength(markdown), fileCount: 0 },
        manifest: [],
        renderedBody: markdown,
        publishedAt: now,
      },
      $setOnInsert: { ownerId: userId },
    },
    { upsert: true, new: true }
  );

  req.logger.info(`[PUBLISH] reply session=${body.sessionId} msg=${body.messageId} → /p/r/${saved.publicId}`);

  const response: PublishResult = {
    publicId: saved.publicId,
    url: `/p/r/${saved.publicId}`,
    tier,
    scopeId,
    slug,
    visibility: viz.visibility,
    publishedAt: now.toISOString(),
  };
  return res.status(200).json(response);
});

/**
 * First non-empty markdown line (stripped of leading #/*), capped, as a title. Embedded
 * `<artifact>` blocks are removed first so a reply that LEADS with an artifact doesn't take
 * the raw `<artifact ...>` wrapper tag as its title (#708); if the reply is nothing but an
 * artifact, fall back to the artifact's own title attribute.
 */
export function deriveTitle(markdown: string): string {
  const { artifacts, cleanedContent } = parseArtifactsWithFallback(markdown);
  const firstLine = cleanedContent
    .split('\n')
    .map(l => l.trim())
    .find(Boolean);
  if (firstLine) {
    const cleaned = firstLine
      .replace(/^#+\s*/, '')
      .replace(/^[*_>-]+\s*/, '')
      .slice(0, 120);
    if (cleaned) return cleaned;
  }
  const named = artifacts.find(a => a.title && a.title !== 'Untitled Artifact');
  return named?.title?.slice(0, 120) || 'Shared reply';
}

export const config = {
  api: { externalResolver: true },
};

export default handler;

import { baseApi } from '@server/middlewares/baseApi';
import { Quest, Session } from '@bike4mind/database';
import { PublishReplyRequestSchema, type PublishResult, type CitableSource, visibleReplyText } from '@bike4mind/common';
import { resolveVisibility, checkScopePermission, type PublishUser } from '@server/services/publish';
import { settlePublication } from '@server/services/publish/settlePublication';
import { parseArtifactsWithFallback } from '@client/app/utils/artifactParser';
import {
  REPLY_TITLE_MAX,
  replyFirstLine,
  stripInlineMarkdown,
  truncateAtWord,
} from '@server/services/publish/plainTitle';

/**
 * POST /api/publish/reply - publish a single assistant reply as a public viewer
 * page. Unlike bundles, replies skip the upload->S3->finalize dance: we snapshot
 * the reply markdown into the record (renderedBody) and serve it server-side at
 * /p/r/{publicId}. Re-publishing the same message updates the owner's existing record in place
 * (same publicId), including its scope and visibility.
 */

/**
 * Extract the assistant reply as markdown, mirroring the client's extractReplies:
 * prefer the `replies[]` array (the server streams into it), fall back to the flat
 * `reply`, then to text blocks in `structuredReplies`. Hidden reasoning is stripped by
 * `visibleReplyText`, the same rule the transcript renders by - a published page must not
 * show text the chat hides, and vice versa.
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
    const cleaned = visibleReplyText(part);
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

  // Load the message (a Quest). The streamed answer lives in `replies[]`
  // (authoritative), falling back to the flat `reply`, then to text blocks in
  // `structuredReplies` - mirror the UI's extractReplies so a published reply
  // matches what the user sees on screen.
  const quest = await Quest.findOne({ _id: body.messageId, sessionId: body.sessionId })
    .select('reply replies structuredReplies promptMeta.citables')
    .lean<{
      reply?: string | null;
      replies?: string[] | null;
      structuredReplies?: Array<{ content?: unknown }> | null;
      promptMeta?: { citables?: CitableSource[] } | null;
    } | null>();
  if (!quest) {
    return res.status(404).json({ error: 'Reply not found' });
  }

  // Ownership lives on the Session, not the Quest: ChatHistoryItemSchema has no
  // top-level userId, so read the owner from the parent session (userId is
  // required there). Reading it off the Quest silently 403s every non-admin.
  const session = await Session.findById(body.sessionId).select('userId').lean<{ userId: string } | null>();
  if (!session) {
    return res.status(404).json({ error: 'Reply not found' });
  }
  if (String(session.userId) !== userId && !req.user.isAdmin) {
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

  // One publication per owner+reply, rewritten in place on re-publish - see settlePublication.
  const settled = await settlePublication({
    ownerId: userId,
    isAdmin: req.user.isAdmin,
    source: { kind: 'reply', sessionId: body.sessionId, messageId: body.messageId },
    tier,
    scopeId,
    visibility: viz.visibility,
    title: body.title?.trim() || deriveTitle(markdown),
    renderedBody: markdown,
    extraSet: { citables: quest.promptMeta?.citables ?? undefined },
    logger: req.logger,
  });
  if (!settled.ok) {
    return res.status(settled.status).json(settled.body);
  }
  const { saved, slug, publishedAt } = settled;

  req.logger.info(`[PUBLISH] reply session=${body.sessionId} msg=${body.messageId} → /p/r/${saved.publicId}`);

  const response: PublishResult = {
    publicId: saved.publicId,
    url: `/p/r/${saved.publicId}`,
    tier,
    scopeId,
    slug,
    visibility: viz.visibility,
    publishedAt: publishedAt.toISOString(),
  };
  return res.status(200).json(response);
});

/**
 * First non-empty markdown line (stripped of leading #/* and inline markdown), capped, as a title. Embedded
 * `<artifact>` blocks are removed first so a reply that LEADS with an artifact doesn't take
 * the raw `<artifact ...>` wrapper tag as its title (#708); if the reply is nothing but an
 * artifact, fall back to the artifact's own title attribute. Serve's displayReplyTitle
 * (server/services/publish/plainTitle.ts) recognizes rows this cut before it stripped markers.
 */
export function deriveTitle(markdown: string): string {
  const firstLine = replyFirstLine(markdown);
  if (firstLine) {
    const cleaned = truncateAtWord(
      stripInlineMarkdown(firstLine.slice(0, REPLY_TITLE_MAX * 4).replace(/^#+\s*/, '')).replace(/^[*_>-]+\s*/, ''),
      REPLY_TITLE_MAX
    );
    if (cleaned) return cleaned;
  }
  const named = parseArtifactsWithFallback(markdown).artifacts.find(a => a.title && a.title !== 'Untitled Artifact');
  return (named?.title && truncateAtWord(named.title, REPLY_TITLE_MAX)) || 'Shared reply';
}

export { truncateAtWord };

export const config = {
  api: { externalResolver: true },
};

export default handler;

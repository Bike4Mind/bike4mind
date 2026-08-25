import { baseApi } from '@server/middlewares/baseApi';
import { PublishedArtifact, AppFile } from '@bike4mind/database';
import { AppFileReservedTags, normalizePublishTag } from '@bike4mind/common';

/**
 * GET /api/publish/tags - the caller's own tag vocabulary, for autocomplete.
 *
 * Drawn from BOTH the caller's published artifacts and their AppFile tags, because a label
 * should mean one thing across the app: if a file is already tagged `ionq`, offering `IonQ` as a
 * fresh suggestion on the publish side is how you end up with two tags for one subject. Tags stay
 * freeform - nothing here restricts what may be typed; this only shapes what is SUGGESTED.
 *
 * `count` is uses among published artifacts only. An AppFile-only tag therefore arrives with
 * count 0, which is honest: it is a real part of the caller's vocabulary but not yet used on
 * anything published, and the UI can order suggestions accordingly.
 *
 * Owner-scoped with no cross-user reads: a vocabulary is personal, and pooling it org-wide would
 * leak the shape of other people's libraries through an autocomplete.
 */

/** AppFile's reserved tags are MECHANISM - they mark a file as a logo, an avatar, a docx
 *  template - not labels a person chose. Suggesting them as artifact tags would be noise, and
 *  applying one to an artifact would imply a role the publish system does not honour. */
const RESERVED = new Set<string>(Object.values(AppFileReservedTags).map(String));

/** Bounded so a pathological library cannot return an unbounded payload to an autocomplete. */
const MAX_TAGS = 500;

const handler = baseApi().get(async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const userId = String(req.user.id);

  const [published, fileTags] = await Promise.all([
    PublishedArtifact.aggregate<{ _id: string; n: number }>([
      { $match: { ownerId: userId, deletedAt: null } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: MAX_TAGS },
    ]),
    // AppFile stores userId, not ownerId. Distinct rather than an aggregation: no counts are
    // wanted from this side, only membership in the vocabulary.
    AppFile.distinct('tags', { userId }),
  ]);

  const counts = new Map<string, number>();
  for (const row of published) {
    const tag = normalizePublishTag(String(row._id ?? ''));
    if (tag && !RESERVED.has(tag)) counts.set(tag, row.n);
  }
  for (const raw of (fileTags as unknown[]) ?? []) {
    const tag = normalizePublishTag(String(raw ?? ''));
    // Normalizing the AppFile side too is what makes the vocabularies actually share: those tags
    // were written without this normalizer, so `IonQ` there and `ionq` here are one entry.
    if (tag && !RESERVED.has(tag) && !counts.has(tag)) counts.set(tag, 0);
  }

  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    // Most-used first, then alphabetical, so the ordering is stable between requests and the
    // suggestions a person reaches for most are the ones at the top.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, MAX_TAGS);

  return res.status(200).json({ tags });
});

export const config = {
  api: { externalResolver: true },
};

export default handler;

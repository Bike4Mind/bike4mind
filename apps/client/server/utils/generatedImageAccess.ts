import type { IUserDocument } from '@bike4mind/common';
import { questRepository, sessionRepository } from '@bike4mind/database';

/**
 * Object-level authz for AI-generated images.
 *
 * Generated-image keys (`<uuid>.<ext>`) live in an owner-less bucket with no per-image DB row, so
 * a caller-supplied key carries no ownership on its own. The one server-side signal is
 * `quest.images`: the array recording every generated file a chat turn produced. A key is the
 * caller's iff a quest referencing it belongs to a session the caller can read (owner, user share or
 * group share) - the same rule GET /api/sessions/[id]/generated-media applies.
 *
 * This also covers legacy (pre-fix) keys: they are in `quest.images` too, so the check protects
 * historical images without any key-format migration. A key that no quest references (a truly
 * orphaned key) is inaccessible - a generated image is only reachable through the chat that made it.
 *
 * Its owner-only twin for edit_image inputs is resolveOwnedGeneratedImageUrl (@bike4mind/services);
 * keep the two lookups in sync.
 */
export async function userCanAccessGeneratedImage(
  imageKey: string,
  user: Pick<IUserDocument, 'id' | 'groups'>
): Promise<boolean> {
  if (!imageKey || !user.id) return false;
  const sessionIds = await questRepository.findSessionIdsByImage(imageKey);
  if (sessionIds.length === 0) return false;
  // includeDeleted mirrors findSessionIdsByImage: a key from a soft-deleted quest or session still
  // belongs to that session's owner, so the owner must not lose access to their own image.
  // The shared read arms (owner, users[], groups[]), so whoever can read the chat can read its images.
  const sessions = await sessionRepository.shareable.findAllAccessibleByIds(user, sessionIds, { includeDeleted: true });
  return sessions.length > 0;
}

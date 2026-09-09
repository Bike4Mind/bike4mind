import { questRepository, sessionRepository } from '@bike4mind/database';

/**
 * Object-level authz for AI-generated images.
 *
 * Generated-image keys (`<uuid>.<ext>`) live in an owner-less bucket with no per-image DB row, so
 * a caller-supplied key carries no ownership on its own. The one server-side signal is
 * `quest.images`: the array recording every generated file a chat turn produced. A key is the
 * caller's iff a quest referencing it belongs to a session the caller owns or is shared on - the
 * same access rule GET /api/quests/[id] applies to a whole quest.
 *
 * This also covers legacy (pre-fix) keys: they are in `quest.images` too, so the check protects
 * historical images without any key-format migration. A key that no quest references (a truly
 * orphaned key) is inaccessible - a generated image is only reachable through the chat that made it.
 */
export async function userCanAccessGeneratedImage(imageKey: string, userId: string): Promise<boolean> {
  if (!imageKey || !userId) return false;
  const sessionIds = await questRepository.findSessionIdsByImage(imageKey);
  if (sessionIds.length === 0) return false;
  const sessions = await sessionRepository.findAllByIds(sessionIds);
  return sessions.some(session => session.userId === userId || session.users?.some(share => share.userId === userId));
}

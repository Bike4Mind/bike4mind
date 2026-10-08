import { GENERATED_IMAGE_KEY_RE } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { ToolContext } from './types';

export type OwnedGeneratedImageContext = Pick<ToolContext, 'userId' | 'db' | 'imageGenerateStorage' | 'logger'>;

/**
 * Resolve a generated-image storage key (the bare `<uuid>.<ext>` persisted in `quest.images`) to a
 * signed URL, for a tool that hands the image to a provider (edit_image; video_generation next).
 *
 * Generated keys live in an owner-less bucket, so the key alone proves nothing. The caller must
 * OWN it: a quest referencing the key belongs to a session whose `userId` is the caller. Unlike
 * userCanAccessGeneratedImage (apps/client/server/utils/generatedImageAccess.ts), which also serves
 * share recipients for viewing, a share does not count here - a tool call derives new content.
 * Caveat: this guards the bare-key route only. While the CDN serves `/generated/<key>` publicly
 * (infra/buckets.ts), anyone holding a key can fetch it directly, so this is not yet a
 * confidentiality boundary.
 *
 * Throws NotFoundError with one message for a malformed key, an unknown key, a key owned by someone
 * else, and a host that did not wire the lookup (fail closed), so the outcome reveals nothing about
 * whether the key exists.
 */
export async function resolveOwnedGeneratedImageUrl(
  storageKey: string,
  context: OwnedGeneratedImageContext
): Promise<string> {
  if (!(await callerOwnsGeneratedImage(storageKey, context))) {
    throw new NotFoundError(`Generated image "${storageKey}" was not found`);
  }
  return context.imageGenerateStorage.getSignedUrl(storageKey);
}

async function callerOwnsGeneratedImage(storageKey: string, context: OwnedGeneratedImageContext): Promise<boolean> {
  if (!context.userId || !GENERATED_IMAGE_KEY_RE.test(storageKey)) return false;

  const { quests, sessions } = context.db;
  if (!quests || !sessions?.findAllByIds) {
    context.logger.warn('[resolveOwnedGeneratedImageUrl] Ownership lookup not wired; refusing generated image key');
    return false;
  }

  const sessionIds = await quests.findSessionIdsByImage(storageKey);
  if (sessionIds.length === 0) return false;
  // includeDeleted mirrors findSessionIdsByImage: an image from a soft-deleted chat is still its owner's.
  const owningSessions = await sessions.findAllByIds(sessionIds, { includeDeleted: true });
  return owningSessions.some(session => session.userId === context.userId);
}

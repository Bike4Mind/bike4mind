import { GENERATED_IMAGE_KEY_RE } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { ToolContext } from './types';

export type OwnedGeneratedImageContext = Pick<ToolContext, 'userId' | 'db' | 'imageGenerateStorage' | 'logger'>;

/**
 * Resolve a generated-image storage key (the bare `<uuid>.<ext>` persisted in `quest.images`) to a
 * signed URL, for a tool that hands the image to a provider (edit_image; video_generation next).
 *
 * Generated keys live in an owner-less bucket, so the key alone proves nothing. The caller must
 * own a session whose history references the key: a quest holding it belongs to a session whose
 * `userId` is the caller. Being a share recipient does not count - a tool call derives new content -
 * but cloning a shared session or importing a notebook copies `images` into a session the caller
 * owns, so this is "owns a session that references it", not "generated it".
 * The lookup chain mirrors userCanAccessGeneratedImage (apps/client/server/utils/generatedImageAccess.ts),
 * which additionally serves share recipients for viewing - keep the two in sync.
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

import { GENERATED_IMAGE_KEY_RE } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';
import type { ToolContext } from './types';

export type OwnedGeneratedImageContext = Pick<ToolContext, 'userId' | 'db' | 'imageGenerateStorage' | 'logger'>;

/** The owner lookup behind every generated-image input; absent repositories fail closed. */
export type GeneratedImageOwnershipLookup = {
  userId: string;
  quests?: NonNullable<ToolContext['db']['quests']>;
  sessions?: Pick<NonNullable<ToolContext['db']['sessions']>, 'findAllByIds'>;
  logger: Pick<ToolContext['logger'], 'warn'>;
};

/**
 * Resolve a generated-image storage key (the bare `<uuid>.<ext>` persisted in `quest.images`) to a
 * signed URL, for a tool that hands the image to a provider by URL (edit_image).
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
  const lookup = {
    userId: context.userId,
    quests: context.db.quests,
    sessions: context.db.sessions,
    logger: context.logger,
  };
  if (!(await callerOwnsGeneratedImage(storageKey, lookup))) {
    throw new NotFoundError(`Generated image "${storageKey}" was not found`);
  }
  return context.imageGenerateStorage.getSignedUrl(storageKey);
}

/**
 * The ownership rule documented on resolveOwnedGeneratedImageUrl, as a boolean for a caller that needs the bytes
 * rather than a URL (the video job's loadInputImage in apps/client/server/generationJobs/wiring.ts). False for
 * a malformed, unknown or foreign key and for an unwired lookup alike.
 */
export async function callerOwnsGeneratedImage(
  storageKey: string,
  lookup: GeneratedImageOwnershipLookup
): Promise<boolean> {
  if (!lookup.userId || !GENERATED_IMAGE_KEY_RE.test(storageKey)) return false;

  const { quests, sessions, userId } = lookup;
  if (!quests || !sessions?.findAllByIds) {
    lookup.logger.warn('[callerOwnsGeneratedImage] Ownership lookup not wired; refusing generated image key');
    return false;
  }

  const sessionIds = await quests.findSessionIdsByImage(storageKey);
  if (sessionIds.length === 0) return false;
  // includeDeleted mirrors findSessionIdsByImage: an image from a soft-deleted chat is still its owner's.
  const owningSessions = await sessions.findAllByIds(sessionIds, { includeDeleted: true });
  return owningSessions.some(session => session.userId === userId);
}

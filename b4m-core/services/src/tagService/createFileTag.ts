import { IFileTag, IFileTagRepository, TagType } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { normalizeTagName } from './tagName';

const tagCreateFileTagSchema = z.object({
  name: z.string().trim().min(1),
  icon: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
});

type TagCreateFileTagSchema = z.infer<typeof tagCreateFileTagSchema>;

interface TagCreateFileTagAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'create' | 'findByFoldedNameAndUserId'>;
  };
}

/**
 * Find-or-create a file tag by name, under the shared collision rule (see tagName): a name the user
 * already holds in ANY casing resolves to that document instead of minting a second one.
 *
 * This is the auto-create door - research tasks name their own tag - so unlike tagService/create it
 * cannot refuse the caller, it has to converge. Without the lookup a generated `Research: Q3` beside
 * a hand-made `research: q3` produced the pair the count aggregate reads as two buckets while the
 * file-list filter reads as one, with no user action involved at all.
 *
 * A `datalake:` name is deliberately NOT refused here: accepting an invite to a shared lake file
 * mints one, which is why tagService/remove has to guard against deleting it.
 *
 * The caller's icon/colour is ignored when an existing document claims the name. Correct for a
 * find-or-create - the document the user already has wins - and the same thing
 * findOrCreateByNameAndUserId's $setOnInsert does.
 */
export const createFileTag = async (
  userId: string,
  parameters: TagCreateFileTagSchema,
  adapters: TagCreateFileTagAdapters
): Promise<IFileTag> => {
  const params = secureParameters(parameters, tagCreateFileTagSchema);
  const name = normalizeTagName(params.name);

  const existing = await adapters.db.fileTags.findByFoldedNameAndUserId(name, userId);
  if (existing) return existing;

  const build: Omit<IFileTag, 'id'> = {
    name,
    icon: params.icon,
    color: params.color,
    description: params.description,
    userId,

    type: TagType.FILE,

    lastActivityAt: new Date(),

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    return await adapters.db.fileTags.create(build);
  } catch (error) {
    // E11000: a concurrent create took the exact name. Converge on whatever landed rather than
    // failing a background task - the caller asked for the tag to exist, and it does. Attributed to
    // the name without inspecting keyPattern because { userId, name } is the ONLY unique index on
    // TagSchema; add a second one and this has to start checking which fired.
    if ((error as { code?: number })?.code === 11000) {
      const raced = await adapters.db.fileTags.findByFoldedNameAndUserId(name, userId);
      if (raced) return raced;
    }
    // Deliberately the raw driver error, unlike tagService/create's worded BadRequestError: there is
    // no HTTP surface here, so nobody reads a friendly message - this lands in a background task's
    // logs, where the driver's own text is the more diagnostic thing to keep.
    throw error;
  }
};

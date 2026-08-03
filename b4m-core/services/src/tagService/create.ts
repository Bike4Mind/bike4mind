import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import { IFileTag, IFileTagRepository, TagType } from '@bike4mind/common';
import { isDataLakeTagName, normalizeTagName } from './tagName';

const tagCreateSchema = z.object({
  name: z.string().trim().min(1),
  icon: z.string().optional(),
  description: z.string().optional(),
  color: z.string().optional(),
  type: z.enum(TagType),
});

type TagCreateParameters = z.infer<typeof tagCreateSchema>;

interface TagCreateAdapters {
  db: {
    fileTags: Pick<IFileTagRepository, 'create' | 'findByFoldedNameAndUserId'>;
    // sessionTags: Pick<ISessionTagRepository, 'create'>;
  };
}

/**
 * Create a tag document, refusing a name the user already holds under the shared collision rule
 * (see tagName): trimmed and case folded. Without that refusal `Invoices` could be created beside
 * `invoices`, and the two disagree - countFilesByTagForUser groups on the exact stored name, so
 * they are separate buckets, while the file-list filter and the row chips match case-insensitively
 * and read them as one tag. Refusing the pair is what keeps those buckets unreachable, so no query
 * has to change. tagService/update applies the same rule and MERGES instead, because a rename has
 * an existing document to fold into.
 *
 * A `datalake:` name is refused for the same reason update and remove refuse one: membership in a
 * lake IS that string on the file, so a hand-made document under that namespace is not an ordinary
 * tag. The auto-create paths deliberately still mint them (accepting an invite to a shared lake
 * file needs one), which is why the refusal lives here and not in the repository.
 *
 * One race survives: the unique index has no collation, so two concurrent creates of `Foo` and
 * `foo` both pass the lookup and both land. listFileTags under-reports such a pair rather than
 * lying about it, and renaming one onto the other merges them. Closing it properly needs a collated
 * index, so a migration plus a backfill for the pairs already stored.
 */
export const create = async (userId: string, parameters: TagCreateParameters, adapters: TagCreateAdapters) => {
  const params = secureParameters(parameters, tagCreateSchema);
  const name = normalizeTagName(params.name);

  // A 4xx like every other refusal here: unreachable from the route, which forces the type after the
  // body spread, but a direct call with the session type would otherwise answer 500.
  if (params.type !== TagType.FILE) {
    throw new BadRequestError('Tag Service - Create: Invalid tag type');
  }

  if (isDataLakeTagName(name)) {
    throw new BadRequestError('Tag Service - Create: a data lake membership tag cannot be created here');
  }

  const existing = await adapters.db.fileTags.findByFoldedNameAndUserId(name, userId);
  if (existing) {
    throw new BadRequestError(`Tag Service - Create: you already have a tag named "${existing.name}"`);
  }

  const buildData = {
    userId,
    ...params,
    name,
    fileCount: 0,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    // The FILE shape specifically: the type guard above is what rules out the session branch, and
    // ITag is a union the repository's create signature does not accept.
  } as IFileTag;

  try {
    return await adapters.db.fileTags.create(buildData);
  } catch (error) {
    // E11000: a concurrent create took the exact name between the lookup and this write. Unhandled
    // it surfaced as a 500, because errorHandler finds no statusCode on a driver error.
    //
    // Attributed to the name without inspecting keyPattern because { userId, name } is the ONLY
    // unique index on TagSchema. Add a second one and this has to start checking which fired.
    if ((error as { code?: number })?.code === 11000) {
      // Re-read so the message names the document that actually won, not this losing submission -
      // otherwise a racing `RUN2-Alpha` is told it already has a tag named `RUN2-Alpha`.
      const winner = await adapters.db.fileTags.findByFoldedNameAndUserId(name, userId);
      throw new BadRequestError(`Tag Service - Create: you already have a tag named "${winner?.name ?? name}"`);
    }
    throw error;
  }
};

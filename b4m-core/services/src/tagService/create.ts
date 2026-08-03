import { secureParameters, BadRequestError } from '@bike4mind/utils';
import { z } from 'zod';
import { IFileTagRepository, ITag, TagType } from '@bike4mind/common';
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

/** Mongo's duplicate-key code. Unwrapped rather than typed, because the driver's error is untyped. */
const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

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
 */
export const create = async (userId: string, parameters: TagCreateParameters, adapters: TagCreateAdapters) => {
  const params = secureParameters(parameters, tagCreateSchema);
  const name = normalizeTagName(params.name);

  if (params.type !== TagType.FILE) {
    throw new Error('Tag Service: Create - Invalid tag type');
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
  } as ITag;

  try {
    return await adapters.db.fileTags.create(buildData);
  } catch (error) {
    // The check above and this write are not atomic, and the unique index has no collation, so it
    // only catches an EXACT re-submit. Left unhandled that surfaced as a 500, because errorHandler
    // finds no statusCode on a driver error. The folded-but-not-exact race (`Foo` and `foo` landing
    // together) still gets through: listFileTags under-reports such a pair rather than lying, and
    // renaming one onto the other merges them. Closing it for real needs a collated unique index,
    // which means a migration plus a backfill for the pairs already stored.
    if (isDuplicateKeyError(error)) {
      throw new BadRequestError(`Tag Service - Create: you already have a tag named "${name}"`);
    }
    throw error;
  }
};

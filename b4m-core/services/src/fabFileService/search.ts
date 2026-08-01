import { IFabFileRepository, IProjectRepository, type DataLakeMembershipScope } from '@bike4mind/common';
import { z } from 'zod';
import { generateSignedUrl, GetFabFileAdapter } from './get';

const searchFabFilesSchema = z.object({
  search: z.string().optional(),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      type: z
        .enum(['text', 'pdf', 'url', 'image', 'excel', 'word', 'json', 'csv', 'markdown', 'code', 'audio'])
        .optional(),
      shared: z.coerce.boolean().optional(), // Indicates if the user is searching for shared files
      curated: z.coerce.boolean().optional(), // Indicates if the user is searching for curated notebook files
      projectId: z.string().optional(),
      ids: z.array(z.string()).optional(),
    })
    .optional(),
  pagination: z
    .object({
      page: z.coerce.number(),
      limit: z.coerce.number(),
    })
    .optional(),
  order: z
    .object({
      by: z.enum(['createdAt', 'fileName', 'fileSize']),
      direction: z.enum(['asc', 'desc']),
    })
    .optional(),
  // Presentation only. Everything that decides WHICH files the caller may see lives in
  // SearchFabFilesServerOptions below, out of reach of request input.
  options: z
    .object({
      textSearch: z.coerce.boolean().optional(),
      excludeContent: z.coerce.boolean().optional(),
    })
    .optional(),
});

export type SearchFabFilesParameters = z.infer<typeof searchFabFilesSchema>;

type SearchFabFilesAdapters = GetFabFileAdapter & {
  db: GetFabFileAdapter['db'] & {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
};

const DEFAULT_PAGE_LIMIT = 20;

/**
 * Every option that widens WHICH files the search may return. All of it is supplied by the SERVER,
 * deliberately outside `SearchFabFilesParameters`: that type is zod-parsed from request input, and
 * each field below reaches an arm of `buildOwnershipConditions` that relaxes ownership. Routing any
 * of it through the parsed params lets a caller name a scope and read files it does not own -
 * `dataLakeTagPrefixes` in particular is an un-ANDed bypass arm that must only ever come from the
 * hardcoded DATA_LAKES registry. A separate argument keeps the whole set un-forgeable.
 *
 * `lakeMembership` additionally names the user whose OWNED files the lake's prefix arm matches, so
 * a forged value would name any user; `restrictToDataLake` DROPS the ownership arms entirely.
 */
export interface SearchFabFilesServerOptions {
  includeShared?: boolean;
  userGroups?: string[];
  dataLakeTags?: string[];
  dataLakeTagPrefixes?: string[];
  scopedTagPrefixes?: string[];
  restrictToDataLake?: boolean;
  lakeMembership?: DataLakeMembershipScope;
}

export const search = async (
  userId: string,
  params: SearchFabFilesParameters,
  { db, storage }: SearchFabFilesAdapters,
  serverOptions?: SearchFabFilesServerOptions
) => {
  const { search = '', filters, pagination, order, options } = searchFabFilesSchema.parse(params);
  const { tags = [], type, shared, curated } = filters || {};
  const { page = 1, limit = DEFAULT_PAGE_LIMIT } = pagination || {};
  const { by = 'fileName', direction = 'asc' } = order || {};
  // Anything a client sent under a scope key was dropped by the parse above (the schema no longer
  // declares those keys and is not strict, so a hostile value is silently ignored, not a 400).
  const { textSearch = false, excludeContent } = options || {};

  // ids / projectId express RESTRICTION ("only these files" / "only this project's files").
  // These used to feed the fileIds EXCLUSION filter, which inverted them - a project-filtered
  // search returned everything EXCEPT the project's files. Fail-closed: a project that cannot
  // be resolved (missing, or no files) restricts to [] (matches nothing) rather than falling
  // through to an unscoped search over all the user's files.
  let restrictToFileIds: string[] | undefined;

  if (filters?.ids && filters.ids.length > 0) {
    restrictToFileIds = filters.ids;
  } else if (filters?.projectId) {
    const project = await db.projects.findById(filters.projectId);
    restrictToFileIds = project ? project.fileIds : [];
  }

  const fabFiles = await db.fabFiles.search(
    userId,
    search,
    { tags, type, shared, curated, restrictToFileIds },
    { page, limit },
    {
      by,
      direction,
    },
    {
      textSearch,
      excludeContent,
      includeShared: serverOptions?.includeShared ?? false,
      userGroups: serverOptions?.userGroups,
      dataLakeTags: serverOptions?.dataLakeTags,
      dataLakeTagPrefixes: serverOptions?.dataLakeTagPrefixes,
      scopedTagPrefixes: serverOptions?.scopedTagPrefixes,
      restrictToDataLake: serverOptions?.restrictToDataLake,
      lakeMembership: serverOptions?.lakeMembership,
    }
  );

  const result = await Promise.all(
    fabFiles.data.map(async fabFile => {
      const res = await generateSignedUrl(fabFile, { db, storage });
      return res;
    })
  );

  return {
    ...fabFiles,
    data: result,
  };
};

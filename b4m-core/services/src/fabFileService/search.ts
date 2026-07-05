import { IFabFileRepository, IProjectRepository } from '@bike4mind/common';
import { z } from 'zod';
import { generateSignedUrl, GetFabFileAdapter } from './get';

const searchFabFilesSchema = z.object({
  search: z.string().optional(),
  filters: z
    .object({
      tags: z.array(z.string()).optional(),
      type: z.enum(['text', 'pdf', 'url', 'image', 'excel', 'word', 'json', 'csv', 'markdown', 'code']).optional(),
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
  options: z
    .object({
      textSearch: z.coerce.boolean().optional(),
      includeShared: z.coerce.boolean().optional(),
      userGroups: z.array(z.string()).optional(),
      dataLakeTags: z.array(z.string()).optional(),
      dataLakeTagPrefixes: z.array(z.string()).optional(),
      scopedTagPrefixes: z.array(z.string()).optional(),
      restrictToDataLake: z.coerce.boolean().optional(),
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

export const search = async (
  userId: string,
  params: SearchFabFilesParameters,
  { db, storage }: SearchFabFilesAdapters
) => {
  const { search = '', filters, pagination, order, options } = searchFabFilesSchema.parse(params);
  const { tags = [], type, shared, curated } = filters || {};
  const { page = 1, limit = DEFAULT_PAGE_LIMIT } = pagination || {};
  const { by = 'fileName', direction = 'asc' } = order || {};
  const {
    textSearch = false,
    includeShared = false,
    userGroups,
    dataLakeTags,
    dataLakeTagPrefixes,
    scopedTagPrefixes,
    restrictToDataLake,
    excludeContent,
  } = options || {};

  let fileIdsToFilter: string[] | undefined;

  if (filters?.ids && filters.ids.length > 0) {
    fileIdsToFilter = filters.ids;
  } else if (filters?.projectId) {
    const project = await db.projects.findById(filters.projectId);

    if (project && project.fileIds.length > 0) {
      fileIdsToFilter = project.fileIds;
    }
  }

  const fabFiles = await db.fabFiles.search(
    userId,
    search,
    { tags, type, shared, curated, fileIds: fileIdsToFilter },
    { page, limit },
    {
      by,
      direction,
    },
    {
      textSearch,
      includeShared,
      userGroups,
      dataLakeTags,
      dataLakeTagPrefixes,
      scopedTagPrefixes,
      restrictToDataLake,
      excludeContent,
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

import { CollectionType } from '@bike4mind/common';
import { convertPipelineForDocumentDB, USE_DOCUMENTDB } from '../utils/documentdb-compat';
import { escapeRegex } from './fabFileSearchQuery';

export interface CollectionSearchParams {
  userId: string;
  page: number;
  limit: number;
  search: string;
  type?: CollectionType;
}

export interface CollectionSearchDeps {
  findSessionIdsByUserId: (userId: string) => Promise<string[]>;
  useDocumentDB?: boolean;
}

export interface CollectionSearchPipeline {
  pipeline: Record<string, unknown>[];
  facetStages: Record<string, Record<string, unknown>[]>;
}

/**
 * Builds the cross-collection search aggregation pipeline.
 * Builder function - performs no DB execution itself, but the injected
 * findSessionIdsByUserId dependency may perform I/O.
 *
 * Returns the pipeline and facet stages for the caller to execute
 * via executeFacetCompatible().
 */
export async function buildCollectionSearchPipeline(
  params: CollectionSearchParams,
  deps: CollectionSearchDeps
): Promise<CollectionSearchPipeline> {
  const { userId, page, limit, search, type } = params;
  const useDocumentDB = deps.useDocumentDB ?? USE_DOCUMENTDB();
  const skip = (page - 1) * limit;

  const deletedAtFilter = {
    $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
  };

  const buildSearchFilter = (nameField: string): Record<string, unknown> => {
    return search ? { [nameField]: { $regex: escapeRegex(search), $options: 'i' } } : {};
  };

  // Pre-fetch user's session IDs if we need ai_images
  let userSessionIds: string[] = [];
  if (!type || type === CollectionType.AI_IMAGE) {
    userSessionIds = await deps.findSessionIdsByUserId(userId);
  }

  // Build the base pipeline with early filtering
  const pipeline: Record<string, unknown>[] = [
    { $match: { _id: null } },

    // Only include sessionmodels if type allows it
    ...(!type || type === CollectionType.NOTEBOOK
      ? [
          {
            $unionWith: {
              coll: 'sessionmodels',
              pipeline: [
                {
                  $match: {
                    userId,
                    ...deletedAtFilter,
                    ...buildSearchFilter('name'),
                  },
                },
                {
                  $project: {
                    id: '$_id',
                    type: { $literal: 'notebook' },
                    name: '$name',
                    updatedAt: '$updatedAt',
                    tags: '$tags',
                  },
                },
              ],
            },
          },
        ]
      : []),

    // Only include fabfiles if type allows it
    ...(!type || type === CollectionType.KNOWLEDGE
      ? [
          {
            $unionWith: {
              coll: 'fabfiles',
              pipeline: [
                {
                  $match: {
                    userId,
                    ...deletedAtFilter,
                    ...buildSearchFilter('fileName'),
                  },
                },
                {
                  $project: {
                    id: '$_id',
                    type: { $literal: 'knowledge' },
                    name: '$fileName',
                    updatedAt: '$updatedAt',
                    tags: '$tags',
                  },
                },
              ],
            },
          },
        ]
      : []),

    // Only include projects if type allows it
    ...(!type || type === CollectionType.PROJECT
      ? [
          {
            $unionWith: {
              coll: 'projects',
              pipeline: [
                {
                  $match: {
                    userId,
                    ...deletedAtFilter,
                    ...buildSearchFilter('name'),
                  },
                },
                {
                  $project: {
                    id: '$_id',
                    type: { $literal: 'project' },
                    name: '$name',
                    updatedAt: '$updatedAt',
                    tags: '$tags',
                  },
                },
              ],
            },
          },
        ]
      : []),

    // Only include quests/ai_images if type allows it - using pre-fetched session IDs
    ...(!type || type === CollectionType.AI_IMAGE
      ? userSessionIds.length > 0
        ? [
            {
              $unionWith: {
                coll: 'quests',
                pipeline: (useDocumentDB ? convertPipelineForDocumentDB : (p: Record<string, unknown>[]) => p)([
                  {
                    $match: {
                      sessionId: { $in: userSessionIds },
                      images: { $exists: true, $ne: [] },
                      ...deletedAtFilter,
                      ...buildSearchFilter('prompt'),
                    },
                  },
                  {
                    $unwind: {
                      path: '$images',
                      preserveNullAndEmptyArrays: false,
                    },
                  },
                  {
                    $project: {
                      id: '$_id',
                      type: { $literal: 'ai_image' },
                      name: '$prompt',
                      updatedAt: '$updatedAt',
                      imageUrl: '$images',
                      questId: '$_id',
                      prompt: '$prompt',
                      sessionId: 1,
                    },
                  },
                ]),
              },
            },
          ]
        : [] // No sessions = no ai_images
      : []),
  ];

  const facetStages: Record<string, Record<string, unknown>[]> = {
    totalCount: [{ $count: 'count' }],
    collections: [{ $sort: { updatedAt: -1 } }, { $skip: skip }, { $limit: limit }],
  };

  return { pipeline, facetStages };
}

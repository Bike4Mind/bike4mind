import { secureParameters } from '@bike4mind/utils';
import {
  RETRIEVAL_EXCLUDE_MARKER_MAX_LENGTH,
  RETRIEVAL_EXCLUDE_MARKERS_MAX,
} from '@bike4mind/utils/retrievalExclusion';
import {
  DATA_LAKE_GROUNDING_MODES,
  IFabFileRepository,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { z } from 'zod';
import type { Logger } from '@bike4mind/observability';
import { projectService } from '..';
import { datalakeTagsFrom } from '../dataLakeService/getDataLakePrompts';

const createSessionParametersSchema = z.object({
  name: z.string(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
  systemPromptText: z.string().optional(),
  systemPromptId: z.string().optional(),
  surface: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  disableUserIntegrations: z.boolean().optional(),
  forceKnowledgeRetrieval: z.boolean().optional(),
  retrievalTags: z.array(z.string()).optional(),
  // Resolved from the lake at the create route (resolveLakeSessionDefaults), NOT client-supplied:
  // the route deletes any client-sent value before merging, so the lake is authoritative for it.
  // secureParameters strips unknown keys, so it MUST be declared here or the resolved grounding mode
  // is silently dropped and the completion path falls back to size-only behavior.
  corpusGroundingMode: z.enum(DATA_LAKE_GROUNDING_MODES).optional(),
  // secureParameters strips unknown keys, so these MUST be declared here or a surface's
  // retrieval-exclusion opt-in is silently dropped at create time.
  retrievalExcludeFilenameMarkers: z
    .array(z.string().trim().min(1).max(RETRIEVAL_EXCLUDE_MARKER_MAX_LENGTH))
    .max(RETRIEVAL_EXCLUDE_MARKERS_MAX)
    .optional(),
  retrievalVectorizedOnly: z.boolean().optional(),
  citationStyle: z.enum(['named', 'indexed']).optional(),
  temperature: z.number().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  autoNamePlaceholder: z.string().optional(),
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  summary: z.string().optional(),
  summaryAt: z.date().optional(),
  clonedSourceId: z.string().optional().nullable(),
  forkedSourceId: z.string().optional().nullable(),
  projectId: z.string().optional(),
  lastUsedModel: z.string().optional().nullable(),
});

type CreateSessionParameters = z.infer<typeof createSessionParametersSchema>;

export interface CreateSessionAdapters {
  db: {
    sessions: ISessionRepository;
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
  };
  /** Optional so existing callers compile; without it a failed lake-tag derivation is silent. */
  logger?: Logger;
}

/**
 * Scope a new session's retrieval to the lake(s) its starting files belong to.
 *
 * `resolveLakeSessionDefaults` covers only the `dataLakeId` path ("start chat with this lake").
 * The surfaces that mint a grounded session from a FILE instead - the Data Lake tree's
 * open/attach-on-/new, and a product surface's own create route - name no lake, so `retrievalTags`
 * stays empty. An empty tag list is NOT a narrow scope: the search's tag clause is skipped outright
 * (`filters.tags.length > 0` in fabFileSearchQuery) and retrieval falls through to EVERY lake the
 * caller can reach. Deriving the tag here is what keeps `session.retrievalTags` an honest
 * description of the session's scope, which both forced retrieval and LakeMemoryFeature read.
 *
 * Resolves through `shareable.findAllAccessibleByIds` - the same reader `addFilesToProjects` uses -
 * so a caller naming a file id they cannot read contributes no tag. `knowledgeIds` is
 * client-writable, so a reader without that filter would make this a cross-tenant read.
 */
async function deriveRetrievalTagsFromFiles(
  user: IUserDocument,
  knowledgeIds: string[],
  adapters: CreateSessionAdapters
): Promise<string[]> {
  try {
    const files = await adapters.db.fabFiles.shareable.findAllAccessibleByIds(user, knowledgeIds);
    return datalakeTagsFrom(files.flatMap(f => f.tags?.map(t => t.name) ?? []));
  } catch (err) {
    // Never fail session creation over a scoping optimization. The degrade is today's behavior
    // (unscoped retrieval), which is why it is reported rather than swallowed.
    adapters.logger?.warn(
      `[sessionService] lake-tag derivation failed; session will retrieve unscoped: ${(err as Error)?.message}`
    );
    return [];
  }
}

export const createSession = async (
  user: IUserDocument,
  parameters: CreateSessionParameters,
  adapters: CreateSessionAdapters
) => {
  const { db } = adapters;
  const {
    knowledgeIds = [],
    artifactIds = [],
    agentIds = [],
    projectId,
    ...rest
  } = secureParameters(parameters, createSessionParametersSchema);

  // Explicit wins: a caller that already resolved a lake (resolveLakeSessionDefaults) or hand-set
  // tags is authoritative, so derivation runs only for a file-seeded session that named neither.
  const retrievalTags =
    rest.retrievalTags?.length || knowledgeIds.length === 0
      ? rest.retrievalTags
      : await deriveRetrievalTagsFromFiles(user, knowledgeIds, adapters);

  const buildData: Omit<ISessionDocument, 'id'> = {
    groups: [],
    users: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    clonedSourceId: rest.clonedSourceId ?? null,
    forkedSourceId: rest.forkedSourceId ?? null,
    lastUsedModel: rest.lastUsedModel ?? null,

    ...rest,

    // After ...rest so the derived value wins over the (absent) request value it stands in for.
    ...(retrievalTags?.length ? { retrievalTags } : {}),
    userId: user.id,
    knowledgeIds,
    artifactIds,
    agentIds,
    firstCreated: new Date(),
    lastUpdated: new Date(),
    updatedAt: new Date(),
    createdAt: new Date(),
  };

  const notebook = await db.sessions.create(buildData);

  if (projectId) {
    const project = await db.projects.shareable.findAccessibleById(user, projectId);
    if (project) {
      await projectService.addSessions(user, { projectId: project.id, sessionIds: [notebook.id] }, adapters);
    }
  }

  return notebook;
};

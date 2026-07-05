import { secureParameters } from '@bike4mind/utils';
import {
  IFabFileRepository,
  IProjectRepository,
  ISessionDocument,
  ISessionRepository,
  IUserDocument,
} from '@bike4mind/common';
import { z } from 'zod';
import { projectService } from '..';

const createSessionParametersSchema = z.object({
  name: z.string(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  agentIds: z.array(z.string()).optional(),
  systemPromptText: z.string().optional(),
  surface: z.string().optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
  disableUserIntegrations: z.boolean().optional(),
  forceKnowledgeRetrieval: z.boolean().optional(),
  retrievalTags: z.array(z.string()).optional(),
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

  const buildData: Omit<ISessionDocument, 'id'> = {
    groups: [],
    users: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    clonedSourceId: rest.clonedSourceId ?? null,
    forkedSourceId: rest.forkedSourceId ?? null,
    lastUsedModel: rest.lastUsedModel ?? null,

    ...rest,

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

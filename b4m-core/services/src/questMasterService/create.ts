import {
  IQuestMasterArtifactRepository,
  createArtifactId,
  calculateContentHash,
  calculateContentSize,
  createDefaultPermissions,
} from '@bike4mind/common';
import { secureParameters, MAX_DESCRIPTION_LENGTH, MAX_GOAL_LENGTH, MAX_TAG_LENGTH } from '@bike4mind/utils';
import { z } from 'zod';

// Quest schema - limits aligned with database and tool schemas
const questSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(255),
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  status: z.enum(['not_started', 'in_progress', 'completed', 'blocked']).prefault('not_started'),
  order: z.number().min(0),
  dependencies: z.array(z.string()).prefault([]),
  estimatedTime: z.string().optional(),
});

const questResourceSchema = z.object({
  title: z.string().min(1).max(255),
  url: z.url(),
  type: z.enum(['documentation', 'tutorial', 'reference', 'example']),
});

// Schema for create QuestMaster parameters - limits aligned with database and tool schemas
const createQuestMasterSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  goal: z.string().min(1).max(MAX_GOAL_LENGTH),
  complexity: z.enum(['beginner', 'intermediate', 'advanced', 'expert']),
  estimatedTotalTime: z.string().optional(),
  prerequisites: z.array(z.string().max(200)).prefault([]),
  quests: z.array(questSchema).min(1),
  resources: z.array(questResourceSchema).prefault([]),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).prefault('private'),
  tags: z.array(z.string().max(MAX_TAG_LENGTH)).max(20).prefault([]),
  permissions: z
    .object({
      canRead: z.array(z.string()).prefault([]),
      canWrite: z.array(z.string()).prefault([]),
      canDelete: z.array(z.string()).prefault([]),
      isPublic: z.boolean().prefault(false),
      inheritFromProject: z.boolean().prefault(true),
    })
    .optional(),
  sourceQuestId: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
});

type CreateQuestMasterParameters = z.infer<typeof createQuestMasterSchema>;

interface CreateQuestMasterAdapters {
  db: {
    questMasterArtifacts: IQuestMasterArtifactRepository;
  };
}

/**
 * Creates a new QuestMaster artifact with quest chain
 */
export const create = async (
  userId: string,
  parameters: CreateQuestMasterParameters,
  adapters: CreateQuestMasterAdapters
) => {
  const { db } = adapters;
  const {
    title,
    description,
    goal,
    complexity,
    estimatedTotalTime,
    prerequisites,
    quests,
    resources,
    projectId,
    organizationId,
    visibility,
    tags,
    permissions,
    sourceQuestId,
    sessionId,
    metadata,
  } = secureParameters(parameters, createQuestMasterSchema);

  const artifactId = createArtifactId();

  const totalQuests = quests.length;
  const completedQuests = quests.filter(q => q.status === 'completed').length;

  const content = {
    goal,
    quests,
    complexity,
    estimatedTotalTime,
    prerequisites,
    resources,
    progressMetrics: {
      totalQuests,
      completedQuests,
      estimatedTimeRemaining: estimatedTotalTime,
    },
  };

  const contentString = JSON.stringify(content);
  const contentHash = calculateContentHash(contentString);
  const contentSize = calculateContentSize(contentString);

  const questMasterPermissions = permissions || createDefaultPermissions(userId);

  const questMaster = {
    id: artifactId,
    type: 'questmaster',
    title,
    description,
    version: 1,
    userId,
    projectId,
    organizationId,
    visibility,
    permissions: questMasterPermissions,
    sourceQuestId,
    sessionId,
    status: 'draft',
    tags,
    content,
    contentHash,
    contentSize,
    metadata,
  };

  const createdQuestMaster = await db.questMasterArtifacts.create(questMaster as any);

  return createdQuestMaster;
};

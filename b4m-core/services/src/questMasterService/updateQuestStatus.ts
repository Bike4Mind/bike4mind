import { IQuestMasterArtifactRepository } from '@bike4mind/common';
import { secureParameters, NotFoundError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';

const updateQuestStatusSchema = z.object({
  artifactId: z.string(),
  questId: z.string(),
  status: z.enum(['not_started', 'in_progress', 'completed', 'blocked']),
  completionNote: z.string().max(500).optional(),
});

type UpdateQuestStatusParameters = z.infer<typeof updateQuestStatusSchema>;

interface UpdateQuestStatusAdapters {
  db: {
    questMasterArtifacts: IQuestMasterArtifactRepository;
  };
}

/**
 * Updates the status of a specific quest within a QuestMaster artifact
 */
export const updateQuestStatus = async (
  userId: string,
  parameters: UpdateQuestStatusParameters,
  adapters: UpdateQuestStatusAdapters
) => {
  const { db } = adapters;
  const { artifactId, questId, status } = secureParameters(parameters, updateQuestStatusSchema);

  const questMaster = await db.questMasterArtifacts.findById(artifactId);
  if (!questMaster) {
    throw new NotFoundError('QuestMaster artifact not found');
  }

  if (questMaster.deletedAt) {
    throw new NotFoundError('QuestMaster artifact not found');
  }

  if (!canUserWriteQuestMaster(userId, questMaster)) {
    throw new UnauthorizedError('Write access denied');
  }

  const questIndex = questMaster.content.quests.findIndex(q => q.id === questId);
  if (questIndex === -1) {
    throw new NotFoundError('Quest not found in QuestMaster');
  }

  const quest = questMaster.content.quests[questIndex];

  if (status === 'completed' && quest.dependencies && quest.dependencies.length > 0) {
    const uncompletedDependencies = quest.dependencies.filter(depId => {
      const depQuest = questMaster.content.quests.find(q => q.id === depId);
      return !depQuest || depQuest.status !== 'completed';
    });

    if (uncompletedDependencies.length > 0) {
      throw new Error(`Cannot complete quest: dependencies not completed: ${uncompletedDependencies.join(', ')}`);
    }
  }

  const updatedQuests = [...questMaster.content.quests];
  updatedQuests[questIndex] = {
    ...quest,
    status,
    completedAt: status === 'completed' ? new Date() : (quest as any).completedAt,
    startedAt: status === 'in_progress' && !(quest as any).startedAt ? new Date() : (quest as any).startedAt,
  } as any;

  const totalQuests = updatedQuests.length;
  const completedQuests = updatedQuests.filter(q => q.status === 'completed').length;

  const updatedContent = {
    ...questMaster.content,
    quests: updatedQuests,
    progressMetrics: {
      totalQuests,
      completedQuests,
      estimatedTimeRemaining: questMaster.content.estimatedDuration,
    },
  };

  const updateData = {
    id: questMaster.id,
    content: updatedContent,
    updatedAt: new Date(),
  };

  await db.questMasterArtifacts.update(updateData as any);

  return {
    questId,
    previousStatus: quest.status,
    newStatus: status,
    progressMetrics: updatedContent.progressMetrics,
    nextAvailableQuest: getNextAvailableQuest(updatedQuests),
  };
};

/**
 * Check if user can write to QuestMaster
 */
function canUserWriteQuestMaster(userId: string, questMaster: any): boolean {
  if (questMaster.userId === userId) {
    return true;
  }

  if (questMaster.permissions?.canWrite?.includes(userId)) {
    return true;
  }

  return false;
}

/**
 * Find the next available quest that can be started
 */
function getNextAvailableQuest(quests: any[]): any | null {
  return (
    quests
      .filter(q => q.status === 'not_started')
      .find(q => q.dependencies?.every((dep: any) => quests.find(dq => dq.id === dep)?.status === 'completed')) || null
  );
}

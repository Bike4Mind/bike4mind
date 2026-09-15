import { BaseArtifact } from './ArtifactTypes';
import { QuestComplexity, SubQuestStatus } from './QuestTypes';

export interface Quest {
  id: string;
  title: string;
  description: string;
  status: SubQuestStatus;
  order: number;
  dependencies?: string[]; // IDs of prerequisite quests
  estimatedMinutes?: number;
  completedAt?: Date;
  completedBy?: string;
  metadata?: Record<string, unknown>;
}

export interface QuestMasterArtifactV2 extends BaseArtifact {
  type: 'questmaster';
  content: QuestMasterContent;
}

export interface QuestMasterContent {
  goal: string;
  quests: Quest[];
  totalSteps: number;
  estimatedDuration?: number; // Total minutes
  complexity: QuestComplexity;
  category?: string;
  prerequisites?: string[];
  completionCriteria?: string[];
  resources?: QuestResource[];
}

export interface QuestResource {
  type: 'documentation' | 'tutorial' | 'example' | 'tool';
  title: string;
  url: string;
  description?: string;
}

// Helper type guards
export function isQuestMasterArtifact(artifact: BaseArtifact): artifact is QuestMasterArtifactV2 {
  return artifact.type === 'questmaster';
}

export function isQuestCompleted(quest: Quest): boolean {
  return quest.status === 'completed';
}

export function calculateQuestProgress(artifact: QuestMasterArtifactV2): {
  completed: number;
  total: number;
  percentage: number;
} {
  const completed = artifact.content.quests.filter(isQuestCompleted).length;
  const total = artifact.content.quests.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return { completed, total, percentage };
}

// Helper to get next available quest
export function getNextAvailableQuest(artifact: QuestMasterArtifactV2): Quest | null {
  const completedQuestIds = artifact.content.quests.filter(isQuestCompleted).map(q => q.id);

  // Find first quest that is not completed and has all dependencies completed
  return (
    artifact.content.quests.find(quest => {
      if (quest.status === 'completed') return false;

      if (!quest.dependencies || quest.dependencies.length === 0) return true;

      return quest.dependencies.every(depId => completedQuestIds.includes(depId));
    }) || null
  );
}

// Helper to estimate remaining time
export function estimateRemainingTime(artifact: QuestMasterArtifactV2): number {
  return artifact.content.quests
    .filter(quest => quest.status !== 'completed' && quest.status !== 'skipped')
    .reduce((total, quest) => total + (quest.estimatedMinutes || 0), 0);
}

import { IQuestMasterPlanDocument } from '@bike4mind/common';

export const mockQuestPlan = {
  id: 'plan-1',
  goal: 'Build a mobile app for fitness tracking',
  state: 'active',
  tags: ['mobile', 'fitness'],
  priority: 'high',
  metrics: {
    totalTimeSpent: 3600,
    completionRate: 33,
    subQuestsCompleted: 2,
    subQuestsTotal: 6,
  },
  quests: [
    {
      id: 'quest-1',
      title: 'Set up project infrastructure',
      description: 'Initialize the React Native project with all necessary dependencies.',
      complexity: 'Easy',
      subQuests: [
        { id: 'sq-1', title: 'Initialize React Native project', status: 'completed' as const },
        { id: 'sq-2', title: 'Configure TypeScript', status: 'completed' as const, startedAt: 1706900000000 },
        { id: 'sq-3', title: 'Set up navigation', status: 'in_progress' as const },
      ],
    },
    {
      id: 'quest-2',
      title: 'Build core features',
      description: 'Implement the main workout tracking functionality.',
      complexity: 'Hard',
      subQuests: [
        { id: 'sq-4', title: 'Create workout model', status: 'not_started' as const },
        { id: 'sq-5', title: 'Build exercise tracker UI', status: 'not_started' as const },
        { id: 'sq-6', title: 'Add timer functionality', status: 'skipped' as const },
      ],
    },
  ],
} as unknown as IQuestMasterPlanDocument;

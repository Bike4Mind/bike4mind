import { create } from 'zustand';

interface QuestPreparationStore {
  isPreparingQuest: boolean;
  questGoal: string | null;
  setPreparingQuest: (goal: string) => void;
  clearPreparingQuest: () => void;
}

/**
 * Global state for quest preparation flow.
 * Used to show a loading overlay that persists across page navigation
 * when creating a new quest from the /quests page.
 */
export const useQuestPreparation = create<QuestPreparationStore>(set => ({
  isPreparingQuest: false,
  questGoal: null,
  setPreparingQuest: (goal: string) => set({ isPreparingQuest: true, questGoal: goal }),
  clearPreparingQuest: () => set({ isPreparingQuest: false, questGoal: null }),
}));

import { create } from 'zustand';

type MessageEditModeStore = {
  editingMessageId: string | null;
  editTarget: 'prompt' | 'reply' | null;
  triggerEdit: (messageId: string, target: 'prompt' | 'reply') => void;
  clearEdit: () => void;
};

export const useMessageEditMode = create<MessageEditModeStore>(set => ({
  editingMessageId: null,
  editTarget: null,
  triggerEdit: (messageId, target) => set({ editingMessageId: messageId, editTarget: target }),
  clearEdit: () => set({ editingMessageId: null, editTarget: null }),
}));

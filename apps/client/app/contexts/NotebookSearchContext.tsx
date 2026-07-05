import { create } from 'zustand';

interface NotebookSearchState {
  search: string;
  showPinnedOnly: boolean;
  setSearch: (search: string) => void;
  setShowPinnedOnly: (showPinnedOnly: boolean) => void;
}

export const useNotebookSearch = create<NotebookSearchState>(set => ({
  search: '',
  showPinnedOnly: false,
  setSearch: search => set({ search }),
  setShowPinnedOnly: showPinnedOnly => set({ showPinnedOnly }),
}));

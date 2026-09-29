import { create } from 'zustand';
import { IFabFileDocument } from '@bike4mind/common';

// Kept apart from Browser.tsx so modules the browser renders (e.g. the data lake wizard) can
// open it without an import cycle.
export const useFileBrowser = create<{
  open: boolean;
  setOpen: (open: boolean) => void;
  fileToShare: IFabFileDocument | null;
  setFileToShare: (fileToShare: IFabFileDocument | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: (selectedIds: Set<string>) => void;
  /**
   * Selected file for instructions
   */
  selectedFileInstructions: IFabFileDocument | null;
  setSelectedFileInstructions: (selectedFileInstructions: IFabFileDocument | null) => void;
}>()(set => ({
  open: false,
  setOpen: (open: boolean) => set({ open }),
  fileToShare: null,
  setFileToShare: (fileToShare: IFabFileDocument | null) => set({ fileToShare }),
  selectedIds: new Set<string>(),
  setSelectedIds: (selectedIds: Set<string>) => set({ selectedIds }),
  selectedFileInstructions: null,
  setSelectedFileInstructions: (selectedFileInstructions: IFabFileDocument | null) => set({ selectedFileInstructions }),
}));

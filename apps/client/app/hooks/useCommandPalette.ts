import { create } from 'zustand';

interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPalette = create<CommandPaletteState>(set => ({
  open: false,
  setOpen: open => set({ open }),
  toggle: () => set(s => ({ open: !s.open })),
}));

export const openCommandPalette = () => useCommandPalette.getState().setOpen(true);
export const closeCommandPalette = () => useCommandPalette.getState().setOpen(false);

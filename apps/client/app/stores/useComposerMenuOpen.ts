import { create } from 'zustand';

interface ComposerMenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Whether the composer's plus menu (AttachFileButton) is open. SessionMiddle hides its
 * scroll-to-bottom button meanwhile: SessionContainer puts the whole composer in a zIndex 10 layer
 * and the button sits at 1100 beside it, so no zIndex inside the menu can lift it over the button.
 */
export const useComposerMenuOpen = create<ComposerMenuState>(set => ({
  open: false,
  setOpen: open => set({ open }),
}));

import { create } from 'zustand';
import { AdminTab } from './adminSidebarConfig';

/**
 * Open/active-tab state for the admin drawer.
 *
 * Deliberately its own module rather than living in AdminPage: non-admin
 * surfaces drive the tab (the chat model picker's "manage models" shortcut),
 * and importing it from AdminPage both cycles back into those surfaces
 * (AdminPage -> SessionContainer -> ... -> ModelSelection) and drags the whole
 * admin tab graph into the chat bundle. Keep this module dependency-light -
 * adminSidebarConfig is a leaf.
 */
export const useAdminModal = create<{
  open: boolean;
  activeTab: AdminTab | string | null;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  setActiveTab: (activeTab: AdminTab | string | null) => void;
}>((set, get) => ({
  open: true, // open by default
  activeTab: AdminTab.Users, // defaults to Users; overridden when migration is available
  setOpen: open => set({ open: typeof open === 'function' ? open(get().open) : open }),
  setActiveTab: (activeTab: AdminTab | string | null) => set({ activeTab }),
}));

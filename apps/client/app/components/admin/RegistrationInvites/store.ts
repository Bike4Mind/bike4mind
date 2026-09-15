import { create } from 'zustand';
import { RegistrationInvitesState } from './types';

export const useRegistrationInvitesStore = create<RegistrationInvitesState>(set => ({
  openCreate: false,
  openDeleteWarning: false,
  copied: false,
  operating: false,
  activeTab: 'available',
  currentPage: 1,
  itemsPerPage: 10,
  unusedSelected: [],
  usedSelected: [],
  multiSelected: [],
  unusedSortDirection: 'desc',
  usedSortDirection: 'desc',
  errors: { multiple: '' },

  setOpenCreate: (open: boolean) => set({ openCreate: open }),
  setOpenDeleteWarning: (open: boolean) => set({ openDeleteWarning: open }),
  setCopied: (copied: boolean) => set({ copied }),
  setOperating: (operating: boolean) => set({ operating }),
  setActiveTab: (tab: 'available' | 'used') => set({ activeTab: tab, currentPage: 1 }),
  setCurrentPage: (page: number) => set({ currentPage: page }),
  setItemsPerPage: (items: number) => set({ itemsPerPage: items, currentPage: 1 }),
  setUnusedSelected: selected =>
    set(state => ({
      unusedSelected: typeof selected === 'function' ? selected(state.unusedSelected) : selected,
    })),
  setUsedSelected: selected =>
    set(state => ({
      usedSelected: typeof selected === 'function' ? selected(state.usedSelected) : selected,
    })),
  setMultiSelected: (selected: string[]) => set({ multiSelected: selected }),
  setUnusedSortDirection: (direction: 'asc' | 'desc') => set({ unusedSortDirection: direction }),
  setUsedSortDirection: (direction: 'asc' | 'desc') => set({ usedSortDirection: direction }),
  toggleUnusedSortDirection: () =>
    set(state => ({
      unusedSortDirection: state.unusedSortDirection === 'desc' ? 'asc' : 'desc',
    })),
  toggleUsedSortDirection: () =>
    set(state => ({
      usedSortDirection: state.usedSortDirection === 'desc' ? 'asc' : 'desc',
    })),
  setErrors: errors => set({ errors }),
  updateError: (field, error) =>
    set(state => ({
      errors: { ...state.errors, [field]: error },
    })),
  clearErrors: () => set({ errors: { multiple: '' } }),
}));

import { RegInviteStatusType } from '@bike4mind/common';

export interface RegInviteData {
  id: string;
  code: string;
  userId: string;
  status: RegInviteStatusType;
  usedbyId?: string;
  createdAt: Date | string;
  unlimitedUse?: boolean;
  expiresAt?: Date | string | null;
  usageHistory?: Array<{ userId: string; usedAt: Date | string }>;
  tags?: string[];
  startingCredits?: number;
  startingStorage?: number;
}

export interface InviteTableProps {
  invites: RegInviteData[];
  allInvites: RegInviteData[];
  borderColor: string;
  selected: string[];
  setSelected: (selected: string[] | ((prev: string[]) => string[])) => void;
  sortDirection: 'asc' | 'desc';
  toggleSortDirection: () => void;
  handleUpdate: (ids: string[], status: RegInviteStatusType) => void;
  handleDelete: (ids: string[]) => void;
  copyToClipboard: (text: string) => void;
  operating: boolean;
  copied: boolean;
  formatDate: (dateString: Date | string | undefined | null) => string;
}

export interface CreateInviteFormData {
  multiple: number;
  unlimitedUse?: boolean;
  tags?: string[];
  startingCredits?: number;
  startingStorage?: number;
}

export interface FormErrors {
  multiple: string;
}

export interface RegistrationInvitesState {
  // Modal states
  openCreate: boolean;
  openDeleteWarning: boolean;

  // UI states
  copied: boolean;
  operating: boolean;

  // Tab state
  activeTab: 'available' | 'used';

  // Pagination state
  currentPage: number;
  itemsPerPage: number;

  // Selection states
  unusedSelected: string[];
  usedSelected: string[];
  multiSelected: string[];

  // Sort states
  unusedSortDirection: 'asc' | 'desc';
  usedSortDirection: 'asc' | 'desc';

  // Error states
  errors: FormErrors;

  // Actions
  setOpenCreate: (open: boolean) => void;
  setOpenDeleteWarning: (open: boolean) => void;
  setCopied: (copied: boolean) => void;
  setOperating: (operating: boolean) => void;
  setActiveTab: (tab: 'available' | 'used') => void;
  setCurrentPage: (page: number) => void;
  setItemsPerPage: (items: number) => void;
  setUnusedSelected: (selected: string[] | ((prev: string[]) => string[])) => void;
  setUsedSelected: (selected: string[] | ((prev: string[]) => string[])) => void;
  setMultiSelected: (selected: string[]) => void;
  setUnusedSortDirection: (direction: 'asc' | 'desc') => void;
  setUsedSortDirection: (direction: 'asc' | 'desc') => void;
  toggleUnusedSortDirection: () => void;
  toggleUsedSortDirection: () => void;
  setErrors: (errors: FormErrors) => void;
  updateError: (field: keyof FormErrors, error: string) => void;
  clearErrors: () => void;
}

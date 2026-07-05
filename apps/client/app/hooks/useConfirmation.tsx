import { ReactNode } from 'react';
import { create } from 'zustand';

interface ConfirmationModalStore {
  open: boolean;
  type: 'default' | 'warning' | 'success' | 'danger';
  title?: ReactNode;
  description?: ReactNode;
  onOk: () => Promise<void> | void;
  okLabel?: string;
  onCancel?: () => void;
  cancelLabel?: string;
  confirm: (value: Partial<Omit<ConfirmationModalStore, 'confirm' | 'open'>>) => void;
}

export const useConfirmationModal = create<ConfirmationModalStore>(set => ({
  open: false,
  type: 'default',
  confirm: value => set({ type: 'default', open: true, ...value }),
  onOk: async () => {},
}));

export const useConfirmation = () => useConfirmationModal.getState().confirm;

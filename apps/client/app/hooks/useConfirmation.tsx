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
  // Zustand shallow-merges, so every optional field has to be cleared explicitly here:
  // otherwise one caller's okLabel/onOk survives into the next dialog that omits it, and
  // a destructive action ends up wearing the previous dialog's labels (or worse, its onOk).
  confirm: value =>
    set({
      type: 'default',
      title: undefined,
      description: undefined,
      okLabel: undefined,
      cancelLabel: undefined,
      onCancel: undefined,
      onOk: async () => {},
      open: true,
      ...value,
    }),
  onOk: async () => {},
}));

export const useConfirmation = () => useConfirmationModal.getState().confirm;

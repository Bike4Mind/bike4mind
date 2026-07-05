import { useState } from 'react';
import { useModalListRestore } from '@client/app/hooks/useModalListRestore';

interface UseModalStateResult {
  // any: SessionBottomModals expects any for triggeredModal (no type definitions yet)
  triggeredModal: any;
  triggeredModalOpen: boolean;
  setTriggeredModalOpen: (open: boolean) => void;
  // any: SessionBottomModals expects any for adminPreviewData (admin tools have no types yet)
  showAdminPreview: boolean;
  setShowAdminPreview: (open: boolean) => void;
  adminPreviewData: any;
  setAdminPreviewData: (data: any) => void;
  formatDialogOpen: boolean;
  setFormatDialogOpen: (open: boolean) => void;
  pasteContentForFormat: string;
  pasteSmartFileName: string;
  modalListPopupOpen: boolean;
  setModalListPopupOpen: (open: boolean) => void;
  modalListData: { modals: any[]; message?: string };
}

export function useModalState(currentSessionId: string | null): UseModalStateResult {
  // any: no type definition for triggered modal payload from admin tools
  const [triggeredModal] = useState<any>(null);
  const [triggeredModalOpen, setTriggeredModalOpen] = useState(false);
  const [showAdminPreview, setShowAdminPreview] = useState(false);
  // any: admin preview data structure has no type definitions yet
  const [adminPreviewData, setAdminPreviewData] = useState<any>(null);
  const [formatDialogOpen, setFormatDialogOpen] = useState<boolean>(false);
  const [pasteContentForFormat] = useState<string>('');
  const [pasteSmartFileName] = useState<string>('');
  const { modalListPopupOpen, setModalListPopupOpen, modalListData } = useModalListRestore(currentSessionId);

  return {
    triggeredModal,
    triggeredModalOpen,
    setTriggeredModalOpen,
    showAdminPreview,
    setShowAdminPreview,
    adminPreviewData,
    setAdminPreviewData,
    formatDialogOpen,
    setFormatDialogOpen,
    pasteContentForFormat,
    pasteSmartFileName,
    modalListPopupOpen,
    setModalListPopupOpen,
    modalListData,
  };
}

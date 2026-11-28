import { useState } from 'react';

interface UseModalStateResult {
  // any: SessionBottomModals expects any for triggeredModal (no type definitions yet)
  triggeredModal: any;
  triggeredModalOpen: boolean;
  setTriggeredModalOpen: (open: boolean) => void;
  formatDialogOpen: boolean;
  setFormatDialogOpen: (open: boolean) => void;
  pasteContentForFormat: string;
  pasteSmartFileName: string;
}

export function useModalState(): UseModalStateResult {
  // any: no type definition for triggered modal payload
  const [triggeredModal] = useState<any>(null);
  const [triggeredModalOpen, setTriggeredModalOpen] = useState(false);
  const [formatDialogOpen, setFormatDialogOpen] = useState<boolean>(false);
  const [pasteContentForFormat] = useState<string>('');
  const [pasteSmartFileName] = useState<string>('');

  return {
    triggeredModal,
    triggeredModalOpen,
    setTriggeredModalOpen,
    formatDialogOpen,
    setFormatDialogOpen,
    pasteContentForFormat,
    pasteSmartFileName,
  };
}

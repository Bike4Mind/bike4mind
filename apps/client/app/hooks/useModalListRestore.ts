import { useEffect, useRef, useState } from 'react';

const MODAL_LIST_STORAGE_KEY = 'pendingModalList';

// any: modalListData structure comes from admin tools with no type definitions yet
interface ModalListData {
  modals: any[];
  message?: string;
}

interface UseModalListRestoreResult {
  modalListPopupOpen: boolean;
  setModalListPopupOpen: (open: boolean) => void;
  modalListData: ModalListData;
  setModalListData: (data: ModalListData) => void;
}

/**
 * Manages modal list popup state and restores pending modal data
 * from sessionStorage after navigation (e.g., new session creation).
 */
export function useModalListRestore(currentSessionId: string | null): UseModalListRestoreResult {
  const [modalListPopupOpen, setModalListPopupOpen] = useState(false);
  const [modalListData, setModalListData] = useState<ModalListData>({ modals: [] });
  const hasOpenedModalListRef = useRef(false);
  const [shouldOpenModalList, setShouldOpenModalList] = useState(false);
  const previousSessionIdForModalRef = useRef<string | null>(null);

  // Reset modal list ref when session changes
  useEffect(() => {
    if (currentSessionId) {
      hasOpenedModalListRef.current = false;
    }
  }, [currentSessionId]);

  // Restore modal list from sessionStorage after navigation (new session creation)
  useEffect(() => {
    const pendingModalList = sessionStorage.getItem(MODAL_LIST_STORAGE_KEY);

    // Only restore if:
    // 1. We have pending modal data
    // 2. We now have a valid currentSessionId
    // 3. We transitioned from null to a real ID (not just any session change)
    const transitionedFromNull = previousSessionIdForModalRef.current === null && currentSessionId !== null;

    if (pendingModalList && currentSessionId && transitionedFromNull) {
      try {
        const modalData = JSON.parse(pendingModalList);

        setModalListData(modalData);
        setShouldOpenModalList(true);

        // Clean up
        sessionStorage.removeItem(MODAL_LIST_STORAGE_KEY);
      } catch (error) {
        console.error('[SessionBottom] Error restoring modal list:', error);
        sessionStorage.removeItem(MODAL_LIST_STORAGE_KEY);
      }
    }

    previousSessionIdForModalRef.current = currentSessionId;
  }, [currentSessionId]);

  // Handle opening modal list popup with proper delay for new sessions
  useEffect(() => {
    if (!shouldOpenModalList) {
      return;
    }

    const delay = hasOpenedModalListRef.current ? 0 : 1000;
    const timeoutId = setTimeout(() => {
      setModalListPopupOpen(true);
      hasOpenedModalListRef.current = true;
      setShouldOpenModalList(false); // Reset trigger
    }, delay);

    return () => clearTimeout(timeoutId);
  }, [shouldOpenModalList]);

  return { modalListPopupOpen, setModalListPopupOpen, modalListData, setModalListData };
}

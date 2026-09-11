import { FullUsersView } from '@client/app/components/admin/Users/Views/FullUsersView';
import { unsavedFieldLabels } from '@client/app/components/admin/Users/unsavedFieldLabels';
import { useGetUser } from '@client/app/hooks/data/user';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { LinearProgress, Modal, ModalClose, ModalDialog } from '@mui/joy';
import { useState } from 'react';
import { create } from 'zustand';

export const useFullUserViewModal = create<{
  userId: string | null;
  setUserId: (userId: string | null) => void;
}>()(set => ({
  userId: null,
  setUserId: userId => set({ userId }),
}));

const FullUserViewModal = () => {
  const userId = useFullUserViewModal(state => state.userId);
  const setUserId = useFullUserViewModal(state => state.setUserId);
  const confirm = useConfirmation();
  // Field keys, not labels: the card owns what changed, this owns how to say it.
  const [unsavedFields, setUnsavedFields] = useState<string[]>([]);

  const user = useGetUser(userId);

  /**
   * The card stages every edit locally and sends them only on Update, so closing
   * this modal silently throws away anything staged - which cost a tester a
   * debugging round when a Custom Tags grant looked applied and was not (#2441).
   * Name what would be lost rather than just asking "are you sure".
   */
  const handleRequestClose = () => {
    if (unsavedFields.length === 0) {
      setUserId(null);
      return;
    }
    confirm({
      type: 'danger',
      title: 'Discard changes?',
      description: `These edits have not been saved: ${unsavedFieldLabels(unsavedFields).join(', ')}. Closing this window discards them. Use Update to save instead.`,
      okLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      onOk: () => setUserId(null),
    });
  };

  return (
    <Modal open={!!userId} onClose={handleRequestClose}>
      <ModalDialog
        data-testid="full-user-view-modal"
        sx={{
          width: '100%',
          maxHeight: '90vh',
          overflowY: 'auto',
          // On mobile, the default center layout (top:50% + translateY(-50%)) causes the modal
          // to jump when the virtual keyboard opens and shifts the visual viewport height.
          // Anchoring to a fixed top position with only horizontal centering prevents this.
          '@media (pointer: coarse)': {
            top: '5%',
            transform: 'translateX(-50%)',
          },
        }}
      >
        <ModalClose data-testid="modal-close-btn" />
        {user.isLoading ? (
          <LinearProgress />
        ) : user.data ? (
          <FullUsersView index={0} user={user.data} inModal onUnsavedFieldsChange={setUnsavedFields} />
        ) : (
          <p>User not found</p>
        )}
      </ModalDialog>
    </Modal>
  );
};
export default FullUserViewModal;

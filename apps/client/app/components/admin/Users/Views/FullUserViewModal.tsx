import { FullUsersView } from '@client/app/components/admin/Users/Views/FullUsersView';
import { useGetUser } from '@client/app/hooks/data/user';
import { LinearProgress, Modal, ModalClose, ModalDialog } from '@mui/joy';
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

  const user = useGetUser(userId);

  return (
    <Modal open={!!userId} onClose={() => setUserId(null)}>
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
          <FullUsersView index={0} user={user.data} inModal />
        ) : (
          <p>User not found</p>
        )}
      </ModalDialog>
    </Modal>
  );
};
export default FullUserViewModal;

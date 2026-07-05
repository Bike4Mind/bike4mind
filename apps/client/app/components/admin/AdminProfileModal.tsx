import ProfileDataForm from '@client/app/components/ProfileModal/ProfileDataForm';
import { useGetUser } from '@client/app/hooks/data/user';
import { LinearProgress, Modal, ModalClose, ModalDialog, Stack } from '@mui/joy';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

export const useAdminProfileModal = create<{
  /**
   * User ID whose profile is being edited; also serves as the modal's open flag.
   */
  userId: string | null;
  setUserId: (userId: string | null) => void;
}>()(set => ({
  userId: null,
  setUserId: userId => set({ userId }),
}));

const AdminProfileModal = () => {
  const [userId, setUserId] = useAdminProfileModal(useShallow(state => [state.userId, state.setUserId]));
  const user = useGetUser(userId);

  return (
    <Modal open={!!userId} onClose={() => setUserId(null)}>
      <ModalDialog data-testid="admin-profile-modal" sx={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <ModalClose data-testid="modal-close-btn" />
          <ContextHelpButton helpId="admin/user-management" tooltipText="User Management Help" />
        </Stack>
        {user.isLoading ? (
          <LinearProgress />
        ) : user.data ? (
          <ProfileDataForm userData={user.data} adminMode />
        ) : (
          <p>User not found</p>
        )}
      </ModalDialog>
    </Modal>
  );
};

export default AdminProfileModal;

import { FullUsersView } from '@client/app/components/admin/Users/Views/FullUsersView';
import { unsavedFieldLabels } from '@client/app/components/admin/Users/unsavedFieldLabels';
import { useGetUser } from '@client/app/hooks/data/user';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { LinearProgress, Modal, ModalClose, ModalDialog } from '@mui/joy';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { USERS_USER_ID_PARAM } from '../usersTabSearch';

/** The user open in the full view, kept in `?userId=` so a refresh or a shared link reopens it. */
export const useFullUserViewModal = () => {
  const userId = useSearch({
    strict: false,
    select: search => (search as Record<string, unknown>)[USERS_USER_ID_PARAM],
  });
  const navigate = useNavigate();

  const setUserId = useCallback(
    (id: string | null) =>
      navigate({
        to: '/admin',
        search: (previous: Record<string, unknown>) => ({ ...previous, [USERS_USER_ID_PARAM]: id ?? undefined }),
        replace: true,
      }),
    [navigate]
  );

  return { userId: typeof userId === 'string' ? userId : null, setUserId };
};

const FullUserViewModal = () => {
  const { userId, setUserId } = useFullUserViewModal();
  const confirm = useConfirmation();
  // Field keys, not labels: the card owns what changed, this owns how to say it.
  const [unsavedFields, setUnsavedFields] = useState<string[]>([]);

  const user = useGetUser(userId);

  // A stale or mistyped `?userId=` closes the modal rather than leaving a dead "not found" pane.
  useEffect(() => {
    if (!userId || !user.isError) return;
    toast.error('That user could not be found.');
    setUserId(null);
  }, [userId, user.isError, setUserId]);

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

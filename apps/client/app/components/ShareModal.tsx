import React from 'react';
import { toast } from 'sonner';
import { Modal, ModalDialog, ModalClose, Button, Stack, Tooltip, Typography } from '@mui/joy';
import { updateSharingOnServer } from '@client/app/utils/sharingApi';
import { getErrorMessage } from '@client/app/utils/error';
import { ShareableEntity, IShareableDocument } from '@bike4mind/common';

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  shareableEntity: ShareableEntity;
  entityType: 'organizations' | 'files' | 'sessions' | 'tools'; // these correspond to the /api/files, /api/sessions endpoints
  onUpdate: (updatedDocument: IShareableDocument) => void;
}

const ShareModal: React.FC<ShareModalProps> = ({ open, onClose, shareableEntity, entityType, onUpdate }) => {
  const handleShareChange = async (type: 'read' | 'write') => {
    if (shareableEntity) {
      let updatedPermissions = {};

      if (type === 'read') {
        updatedPermissions = {
          isGlobalRead: !shareableEntity.isGlobalRead,
          isGlobalWrite: shareableEntity.isGlobalWrite,
        };
      } else if (type === 'write') {
        updatedPermissions = {
          isGlobalRead: true, // Always enable read when enabling write
          isGlobalWrite: !shareableEntity.isGlobalWrite,
        };
      }

      try {
        const updatedDocument = await updateSharingOnServer(
          entityType as string,
          shareableEntity.id,
          updatedPermissions
        );
        onUpdate(updatedDocument);
        onClose();
        return updatedDocument;
      } catch (error) {
        // Global read/write is a publish to the whole instance, so the server now gates it on the
        // SHARE predicate rather than update. Permissions are independently assignable, so an
        // update-without-share holder is a real grant and this call can legitimately be refused -
        // swallowing it into console.error left the button looking inert.
        // getErrorMessage, not error.message: `api` is a bare axios instance with no response
        // interceptor, so an AxiosError's own message is 'Request failed with status code 403' and
        // the server's actual reason is in the error envelope's `error` field.
        toast.error(getErrorMessage(error));
        console.error('Error updating sharing status:', error);
      }
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog>
        <ModalClose />
        <Stack direction="column" spacing={5} sx={{ padding: 5 }}>
          <Typography level="h2">Global Share {shareableEntity?.name}</Typography>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography level="h4">Global Read:</Typography>
            <Tooltip title="Global Read means that anyone in Bike4Mind can view">
              <Button data-testid="share-modal-global-read-btn" onClick={() => handleShareChange('read')}>
                {shareableEntity?.isGlobalRead ? 'Make Private' : 'Make Global'}
              </Button>
            </Tooltip>
          </Stack>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography level="h4">Global Write:</Typography>
            <Tooltip title="Global Write means that anyone in Bike4Mind can edit">
              <Button data-testid="share-modal-global-write-btn" onClick={() => handleShareChange('write')}>
                {shareableEntity?.isGlobalWrite ? 'Disable Write' : 'Enable Write'}
              </Button>
            </Tooltip>
          </Stack>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default ShareModal;

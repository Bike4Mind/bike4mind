import { DialogContent, DialogTitle, Modal, ModalClose, ModalDialog } from '@mui/joy';
import StudioTrail, { type StudioTrailRestore } from './StudioTrail';

type StudioTrailDialogProps = {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onRestore?: StudioTrailRestore;
};

/** StudioTrail in a modal; restoring a step closes it. */
const StudioTrailDialog = ({ fileId, open, onClose, onRestore }: StudioTrailDialogProps) => (
  <Modal open={open} onClose={onClose}>
    <ModalDialog data-testid="studio-trail-dialog" sx={{ width: 'min(520px, 100%)', overflowY: 'auto' }}>
      <ModalClose data-testid="studio-trail-dialog-close-btn" />
      <DialogTitle>Trail</DialogTitle>
      <DialogContent>
        {open && (
          <StudioTrail
            fileId={fileId}
            onRestore={
              onRestore &&
              ((request, medium) => {
                onRestore(request, medium);
                onClose();
              })
            }
          />
        )}
      </DialogContent>
    </ModalDialog>
  </Modal>
);

export default StudioTrailDialog;

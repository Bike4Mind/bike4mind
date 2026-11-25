import { useId } from 'react';
import { Modal, ModalClose, ModalDialog } from '@mui/joy';
import { styled } from '@mui/system';
import StudioThemeScope from '@client/app/components/Studio/design/StudioThemeScope';
import { studioColor, studioFont, studioRadius } from '@client/app/components/Studio/design/studioTokens';
import StudioTrail, { type StudioTrailRestore } from './StudioTrail';

type StudioTrailDialogProps = {
  fileId: string;
  open: boolean;
  onClose: () => void;
  onRestore?: StudioTrailRestore;
};

// The modal portals out of the page, so it carries its own token scope (as the model picker drawer does).
const DialogScope = styled(StudioThemeScope)({
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  minWidth: 0,
  padding: '20px',
  borderRadius: studioRadius('xl'),
  border: `1px solid ${studioColor('border')}`,
});

const Heading = styled('h2')({
  margin: 0,
  paddingRight: '40px',
  font: `600 15px/1.3 ${studioFont('ui')}`,
  color: studioColor('text-strong'),
});

/** StudioTrail in a modal; restoring a step closes it. */
const StudioTrailDialog = ({ fileId, open, onClose, onRestore }: StudioTrailDialogProps) => {
  const headingId = useId();
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        data-testid="studio-trail-dialog"
        aria-labelledby={headingId}
        sx={{
          width: 'min(760px, 100%)',
          p: 0,
          border: 'none',
          bgcolor: 'transparent',
          overflowY: 'auto',
        }}
      >
        <DialogScope testId="studio-trail-dialog-scope">
          <ModalClose data-testid="studio-trail-dialog-close-btn" />
          <Heading id={headingId}>Trail</Heading>
          {open && (
            <StudioTrail
              fileId={fileId}
              onRestore={
                onRestore &&
                (restore => {
                  onRestore(restore);
                  onClose();
                })
              }
            />
          )}
        </DialogScope>
      </ModalDialog>
    </Modal>
  );
};

export default StudioTrailDialog;

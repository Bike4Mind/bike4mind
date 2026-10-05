import type { WorkspaceSurface } from '@bike4mind/common';
import { Box, Button, DialogContent, DialogTitle, List, ListItem, Modal, ModalDialog, Typography } from '@mui/joy';
import { FC } from 'react';

/** Confirms moving a notebook between workspaces, spelling out what the move changes. */
const MoveSessionConfirmModal: FC<{
  open: boolean;
  sessionName: string;
  from: WorkspaceSurface | undefined;
  to: WorkspaceSurface | null;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, sessionName, from, to, loading = false, onConfirm, onCancel }) => {
  if (!to) return null;
  const fromLabel = from?.label ?? 'this workspace';
  return (
    <Modal open={open} onClose={() => !loading && onCancel()}>
      <ModalDialog data-testid="move-session-modal" sx={{ maxWidth: '440px', gap: '16px' }}>
        <DialogTitle sx={{ color: 'text.primary' }}>Move to {to.label}?</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: '16px' }}>
          <Typography sx={{ color: 'text.tertiary' }}>
            &quot;{sessionName}&quot; will move from {fromLabel} to {to.label}.
          </Typography>
          <List marker="disc" size="sm" sx={{ color: 'text.tertiary', '--ListItem-paddingY': '2px' }}>
            <ListItem>
              It will leave {fromLabel}&apos;s notebook list and appear in {to.label}&apos;s.
            </ListItem>
            <ListItem>Panels specific to {fromLabel} will be hidden until you move it back.</ListItem>
            <ListItem>The assistant will use {to.label}&apos;s behavior for new messages.</ListItem>
            <ListItem>People it is shared with will see it move too.</ListItem>
          </List>
          <Box sx={{ display: 'flex', gap: '1rem', justifyContent: 'end' }}>
            <Button
              data-testid="move-session-modal-cancel-btn"
              variant="outlined"
              color="neutral"
              onClick={onCancel}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button data-testid="move-session-modal-confirm-btn" onClick={onConfirm} loading={loading}>
              Move
            </Button>
          </Box>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default MoveSessionConfirmModal;

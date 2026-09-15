import { Card, Box, Button, DialogContent, DialogTitle, Modal, ModalDialog, Typography } from '@mui/joy';
import React from 'react';

export interface MigrationDetailsModalProps {
  open: boolean;
  onClose: () => void;
  migrationDetails: {
    userId: string;
    resetPasswordToken: string;
    resetPasswordSentAt: Date;
    resetPasswordExpires: Date;
  };
}

const MigrationDetailsModal: React.FC<MigrationDetailsModalProps> = ({ open, onClose, migrationDetails }) => {
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <Box sx={{ display: 'flex', justifyContent: 'end' }}>
          <Button onClick={onClose}>Close</Button>
        </Box>
        <DialogTitle>Migration Details</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: '1rem' }}>
          <Typography>User ID: {migrationDetails.userId}</Typography>
          <Card variant="solid">
            <Typography>Reset Password Token: {migrationDetails.resetPasswordToken}</Typography>
            <Typography>Reset Password Sent At: {migrationDetails.resetPasswordSentAt.toString()}</Typography>
            <Typography>Reset Password Expires: {migrationDetails.resetPasswordExpires.toString()}</Typography>
          </Card>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default MigrationDetailsModal;

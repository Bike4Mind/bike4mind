import { useGetUserActivityCounters } from '@client/app/hooks/data/user';
import { Box, Button, DialogContent, DialogTitle, LinearProgress, Modal, ModalDialog, Typography } from '@mui/joy';
import React from 'react';

export interface CountersDetailsModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
}

const CountersDetailsModal: React.FC<CountersDetailsModalProps> = ({ open, onClose, userId }) => {
  const userActivityCounters = useGetUserActivityCounters(open ? userId : null);
  const counters = userActivityCounters.data ?? [];

  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog sx={{ maxHeight: '90vh', overflowY: 'auto' }}>
        <DialogTitle>Counters Details</DialogTitle>
        <DialogContent sx={{ display: 'grid', gap: '1rem' }}>
          {userActivityCounters.isFetching && <LinearProgress />}
          {counters && counters.length > 0 && (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                maxHeight: '40vh',
                overflow: 'auto',
              }}
            >
              {counters.map((counter, index) => (
                <Typography key={index}>
                  {counter.action}: {counter.count}{' '}
                  {counter.tags && counter.tags.length > 0 && `(${counter.tags.join(', ')})`}
                  {/* {counter.updatedAt && ` - Updated at: ${counter.updatedAt.toDateString()}`} */}
                </Typography>
              ))}
            </Box>
          )}
          {!userActivityCounters.isFetching && !counters.length && <Typography>No counters</Typography>}
          <Box sx={{ display: 'flex', justifyContent: 'end' }}>
            <Button onClick={onClose}>Close</Button>
          </Box>
        </DialogContent>
      </ModalDialog>
    </Modal>
  );
};

export default CountersDetailsModal;

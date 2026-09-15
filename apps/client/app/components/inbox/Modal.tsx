import { Drawer, ModalClose, Sheet } from '@mui/joy';
import React from 'react';
import InboxTabs from './InboxTabs';
import { FC } from 'react';
import { useInbox } from '@client/app/contexts/InboxContext';
import { useShallow } from 'zustand/react/shallow';

const InboxModal: FC = () => {
  const [open, setOpen] = useInbox(useShallow(s => [s.open, s.setOpen]));

  return (
    <Drawer
      size={'md'}
      open={open}
      variant={'plain'}
      anchor={'right'}
      onClose={() => setOpen(false)}
      slotProps={{
        content: {
          sx: {
            zIndex: 1000,
            background: 'transparent',
            p: { md: 3, sm: 0 },
            boxShadow: 'none',
          },
        },
      }}
    >
      <Sheet
        sx={{
          borderRadius: 'md',
          p: '20px',
          pt: '10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <ModalClose />
        {open && <InboxTabs />}
      </Sheet>
    </Drawer>
  );
};

export default InboxModal;

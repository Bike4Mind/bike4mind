import { Modal, ModalDialog, Box, Button } from '@mui/joy';
import { FC } from 'react';
import { useUserLogout } from '../hooks/data/user';

const ExpiredSession: FC = () => {
  const { mutate: logout } = useUserLogout();

  return (
    <Modal open>
      <ModalDialog>
        <Box
          textAlign={'center'}
          display="flex"
          justifyContent={'center'}
          alignItems="center"
          flexDirection="column"
          gap="10px"
          width="300px"
        >
          For your security, your session has expired due to inactivity. Please log in again to continue.
          <Button onClick={() => logout()}>Login</Button>
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default ExpiredSession;

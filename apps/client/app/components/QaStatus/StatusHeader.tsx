import { FC, ReactNode } from 'react';
import { IconButton, Stack } from '@mui/joy';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useNavigate } from '@tanstack/react-router';

/** Top row of the /status pages (they render without the app sidenav): page title or back link, plus a close button to the app home. */
const StatusHeader: FC<{ children: ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  return (
    <Stack direction="row" alignItems="center" justifyContent="space-between">
      {children}
      <IconButton aria-label="Close" data-testid="qa-status-close-btn" onClick={() => navigate({ to: '/' })}>
        <CloseRoundedIcon />
      </IconButton>
    </Stack>
  );
};

export default StatusHeader;

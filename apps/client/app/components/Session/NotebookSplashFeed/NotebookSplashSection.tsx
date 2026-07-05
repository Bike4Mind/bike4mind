import { Box } from '@mui/joy';
import { PropsWithChildren } from 'react';

const NotebookSplashSection = ({ children }: PropsWithChildren) => {
  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: theme => theme.palette.session.cardBorder,
        borderRadius: '8px',
        backgroundColor: 'background.panel2',
        padding: '16px',
        width: '100%',
        overflowY: { xs: 'unset', sm: 'auto' },
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </Box>
  );
};
export default NotebookSplashSection;

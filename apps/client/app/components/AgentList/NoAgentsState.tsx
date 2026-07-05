import { FC } from 'react';
import { Box, Typography } from '@mui/joy';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import CreateAgentButton from './CreateAgentButton';

const NoAgentsState: FC = () => {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
        gap: 2,
        px: 3,
      }}
    >
      <SmartToyOutlinedIcon sx={{ fontSize: 64, color: 'text.tertiary', opacity: 0.5 }} />
      <Typography level="title-lg" sx={{ color: 'text.primary' }}>
        No agents yet
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', maxWidth: 360 }}>
        Agents help with specific tasks and access specialized knowledge. Create one to get started.
      </Typography>
      <CreateAgentButton variant="empty" testId="agents-empty-create-btn" />
    </Box>
  );
};

export default NoAgentsState;

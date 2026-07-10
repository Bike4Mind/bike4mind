import { FC } from 'react';
import { Box, Typography } from '@mui/joy';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import CreateAgentButton from './CreateAgentButton';

interface NoAgentsStateProps {
  /** 'empty' (default): first-run, no agents exist yet, offers Create.
   *  'no-results': a search returned nothing - keep the user oriented, no Create. */
  variant?: 'empty' | 'no-results';
  /** The active search query, shown in the no-results copy. */
  query?: string;
}

const NoAgentsState: FC<NoAgentsStateProps> = ({ variant = 'empty', query }) => {
  const isNoResults = variant === 'no-results';
  return (
    <Box
      data-testid={isNoResults ? 'agents-no-results' : 'agents-empty-state'}
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
        {isNoResults ? 'No matching agents' : 'No agents yet'}
      </Typography>
      <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', maxWidth: 360 }}>
        {isNoResults
          ? `No agents match "${query?.trim()}". Try a different search.`
          : 'Agents help with specific tasks and access specialized knowledge. Create one to get started.'}
      </Typography>
      {!isNoResults && <CreateAgentButton variant="empty" testId="agents-empty-create-btn" />}
    </Box>
  );
};

export default NoAgentsState;

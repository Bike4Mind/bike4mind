import React from 'react';
import { Box, Divider, Stack, Typography } from '@mui/joy';
import { SystemPromptsManager } from './SystemPromptsManager';
import SystemPromptEditor from './SystemPromptEditor';

const SystemPromptsTab: React.FC = () => {
  return (
    <Box sx={{ p: 3, height: '100%', overflowY: 'auto' }}>
      <Stack spacing={3}>
        {/* Versioned prompt editor */}
        <SystemPromptEditor />

        <Divider>
          <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
            Global Knowledge Files
          </Typography>
        </Divider>

        {/* System files manager */}
        <SystemPromptsManager />
      </Stack>
    </Box>
  );
};

export default SystemPromptsTab;

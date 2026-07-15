'use client';

import React, { useCallback } from 'react';
import { Box, IconButton, Typography, Tooltip } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ChatPanelControls from './ChatPanelControls';

interface DockedChatPanelProps {
  children: React.ReactNode;
  headerActions?: React.ReactNode;
}

const DockedChatPanel: React.FC<DockedChatPanelProps> = ({ children, headerActions }) => {
  const layout = useSessionLayout(s => s.layout);

  const handleClose = useCallback(() => {
    setSessionLayout({ layout: 'floatingChat' });
  }, []);

  return (
    <Box
      data-testid="docked-chat-panel"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Header bar */}
      <Box
        sx={theme => ({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: '48px',
          padding: '0 16px',
          backgroundColor: theme.palette.background.level1,
          borderBottom: '1px solid',
          borderColor: theme.palette.divider,
          userSelect: 'none',
          flexShrink: 0,
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography
            level="body-sm"
            fontWeight="md"
            sx={theme => ({ color: theme.palette.sidenav?.navItemText ?? theme.palette.text.primary })}
          >
            AI Chat
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {/* Session actions first (headerActions leads with the primary New Chat),
              then window controls. */}
          {headerActions}
          <ChatPanelControls
            testIdPrefix="docked-chat"
            activeLayout={layout === 'dockRight' || layout === 'dockBottom' ? layout : undefined}
            showFloat
          />
          <Tooltip title="Close" disableInteractive>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleClose}
              data-testid="docked-chat-close"
              sx={{ '--IconButton-size': '28px' }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>
      </Box>

      {/* Chat content */}
      <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>{children}</Box>
    </Box>
  );
};

export default DockedChatPanel;

'use client';

import React, { useCallback } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import ChatPanelControls, { chatHeaderToolButtonSx } from './ChatPanelControls';

interface DockedChatPanelProps {
  children: React.ReactNode;
  headerActions?: React.ReactNode;
  /** Overrides the default "AI Chat" header label (e.g. /opti swaps in the Data Lakes toggle). */
  title?: React.ReactNode;
}

const DockedChatPanel: React.FC<DockedChatPanelProps> = ({ children, headerActions, title }) => {
  const layout = useSessionLayout(s => s.layout);

  // "Hide chat": dismiss the panel down to the bottom-right "AI Chat" launcher (the
  // minimized FloatingChatWindow pill) rather than opening the floating window.
  const handleHide = useCallback(() => {
    setSessionLayout({
      layout: 'floatingChat',
      floatingChatMinimized: true,
      // Remembered so expanding the pill returns the chat to this dock. Narrowed rather than
      // defaulted so a dock layout added later cannot silently collapse to dockRight.
      hiddenFromLayout: layout === 'dockBottom' || layout === 'dockRight' ? layout : 'dockRight',
    });
  }, [layout]);

  return (
    <Box
      data-testid="docked-chat-panel"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        // overflow:hidden is what makes the radius actually clip the header bar's corners.
        overflow: 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '8px',
      }}
    >
      {/* Header bar */}
      <Box
        sx={theme => ({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          // Matches the sidenav header and the /opti mission-deck header so the
          // three top bars line up across the app chrome.
          height: '56px',
          padding: '0 16px',
          backgroundColor: theme.palette.background.level1,
          borderBottom: '1px solid',
          borderColor: theme.palette.divider,
          userSelect: 'none',
          flexShrink: 0,
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {title ?? (
            <Typography
              level="body-sm"
              fontWeight="md"
              sx={theme => ({ color: theme.palette.sidenav?.navItemText ?? theme.palette.text.primary })}
            >
              AI Chat
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Layout menu leads the cluster, then the surface's own actions (headerActions),
              with Hide chat last as the control nearest the pane edge. */}
          <ChatPanelControls
            testIdPrefix="docked-chat"
            activeLayout={layout === 'dockRight' || layout === 'dockBottom' ? layout : undefined}
            showFloat
          />
          {headerActions}
          <Tooltip title="Hide chat" disableInteractive>
            <IconButton
              size="md"
              variant="outlined"
              color="neutral"
              onClick={handleHide}
              data-testid="docked-chat-close"
              aria-label="Hide chat"
              sx={chatHeaderToolButtonSx}
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

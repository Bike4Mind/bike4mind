import React from 'react';
import { Box } from '@mui/joy';
import { useTheme } from '@mui/joy/styles';
import { useMediaQuery } from '@mui/system';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

interface AdminChatDockProps {
  content: React.ReactNode;
  chat: React.ReactNode;
}

/**
 * Lays out the admin content and the assistant chat. Docked layouts give the chat an in-flow slot
 * beside ("Dock left" = dockRight, on the left) or below the content; every other layout keeps the
 * slot clipped to 0x0, which is enough for the fixed-position floating window and pill.
 *
 * DOM order is always [content, chat slot], so SessionContainer (and any stream it holds) stays
 * mounted across layout changes. The panel/pill contents still swap inside SessionContainer.
 */
const AdminChatDock: React.FC<AdminChatDockProps> = ({ content, chat }) => {
  const layout = useSessionLayout(s => s.layout);
  const dockChatWidth = useSessionLayout(s => s.dockChatWidth);
  const dockChatHeight = useSessionLayout(s => s.dockChatHeight);
  // Below md (the admin sidebar's breakpoint too) the viewport is too narrow for a 320px side dock plus the content.
  const isWide = useMediaQuery(useTheme().breakpoints.up('md'));

  const docked = layout === 'dockRight' || layout === 'dockBottom';
  const sideBySide = layout === 'dockRight' && isWide;

  return (
    <Box
      data-testid="admin-chat-dock"
      data-layout={layout}
      sx={{
        height: '100%',
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: !docked ? 'column' : sideBySide ? 'row-reverse' : 'column',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{content}</Box>
      <Box
        data-testid="admin-chat-slot"
        sx={
          !docked
            ? { position: 'absolute', top: 0, left: 0, width: 0, height: 0, overflow: 'hidden' }
            : sideBySide
              ? { flexShrink: 0, width: `${dockChatWidth}%`, minWidth: 320, p: 1 }
              : { flexShrink: 0, height: `${dockChatHeight}%`, minHeight: 240, p: 1 }
        }
      >
        {chat}
      </Box>
    </Box>
  );
};

export default AdminChatDock;

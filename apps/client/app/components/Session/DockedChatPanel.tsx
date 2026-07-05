'use client';

import React, { useCallback, useState } from 'react';
import { Box, IconButton, Typography, Tooltip } from '@mui/joy';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { convertSessionToMarkdown } from '@client/app/utils/sessionMarkdownExport';

interface DockedChatPanelProps {
  children: React.ReactNode;
  headerActions?: React.ReactNode;
}

const DockedChatPanel: React.FC<DockedChatPanelProps> = ({ children, headerActions }) => {
  const [copied, setCopied] = useState(false);
  const layout = useSessionLayout(s => s.layout);
  const { currentSessionId } = useSessions();
  const queryClient = useQueryClient();

  const handleCopyMarkdown = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const queryData = queryClient.getQueryData<InfiniteData<{ data: IChatHistoryItemDocument[] }>>([
        'quests',
        'session',
        currentSessionId,
      ]);
      if (!queryData?.pages) return;

      const quests = queryData.pages.flatMap(p => p.data).reverse();
      const markdown = convertSessionToMarkdown(quests);

      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy markdown:', err);
    }
  }, [currentSessionId, queryClient]);

  const handleSwitchToFloat = useCallback(() => {
    setSessionLayout({ layout: 'floatingChat', previousLayout: layout });
  }, [layout]);

  const handleSwitchToDockRight = useCallback(() => {
    setSessionLayout({ layout: 'dockRight' });
  }, []);

  const handleSwitchToDockBottom = useCallback(() => {
    setSessionLayout({ layout: 'dockBottom' });
  }, []);

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
          padding: '8px 12px',
          backgroundColor: theme.palette.background.level1,
          borderBottom: '1px solid',
          borderColor: theme.palette.divider,
          userSelect: 'none',
          flexShrink: 0,
        })}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <SmartToyIcon sx={{ fontSize: 18, color: 'primary.main' }} />
          <Typography level="body-sm" fontWeight="md">
            AI Chat
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Tooltip title={copied ? 'Copied!' : 'Copy chat as Markdown'} disableInteractive>
            <IconButton
              size="sm"
              variant="plain"
              color={copied ? 'success' : 'neutral'}
              onClick={handleCopyMarkdown}
              data-testid="docked-chat-copy-markdown"
              sx={{ '--IconButton-size': '28px' }}
            >
              {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
            </IconButton>
          </Tooltip>
          {headerActions}
          <Tooltip title="Float" disableInteractive>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              onClick={handleSwitchToFloat}
              data-testid="docked-chat-float"
              sx={{ '--IconButton-size': '28px' }}
            >
              <OpenInNewIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Dock right" disableInteractive>
            <IconButton
              size="sm"
              variant={layout === 'dockRight' ? 'soft' : 'plain'}
              color={layout === 'dockRight' ? 'primary' : 'neutral'}
              onClick={handleSwitchToDockRight}
              data-testid="docked-chat-dock-right"
              sx={{ '--IconButton-size': '28px' }}
            >
              <VerticalSplitIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Dock bottom" disableInteractive>
            <IconButton
              size="sm"
              variant={layout === 'dockBottom' ? 'soft' : 'plain'}
              color={layout === 'dockBottom' ? 'primary' : 'neutral'}
              onClick={handleSwitchToDockBottom}
              data-testid="docked-chat-dock-bottom"
              sx={{ '--IconButton-size': '28px' }}
            >
              <HorizontalSplitIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
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

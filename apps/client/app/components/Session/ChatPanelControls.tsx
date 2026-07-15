'use client';

import React from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useCopySessionMarkdown } from './useCopySessionMarkdown';

interface ChatPanelControlsProps {
  /** data-testid prefix, e.g. 'docked-chat' or 'floating-chat' */
  testIdPrefix: string;
  /** Current docked layout; highlights the matching dock button and is recorded
   *  as previousLayout when switching to float. Omit in the floating window. */
  activeLayout?: 'dockRight' | 'dockBottom';
  /** Render the "Float" button (docked panels only). */
  showFloat?: boolean;
}

/**
 * The window-control cluster shared by DockedChatPanel and FloatingChatWindow:
 * copy-as-markdown, optional Float, and the two dock-direction buttons.
 * Panel-specific trailing buttons (Minimize/Close) stay in the panels.
 */
const ChatPanelControls: React.FC<ChatPanelControlsProps> = ({ testIdPrefix, activeLayout, showFloat = false }) => {
  const { copyMarkdown, copied } = useCopySessionMarkdown();

  return (
    <>
      <Tooltip title={copied ? 'Copied!' : 'Copy chat as Markdown'} disableInteractive>
        <IconButton
          size="sm"
          variant="plain"
          color={copied ? 'success' : 'neutral'}
          onClick={copyMarkdown}
          data-testid={`${testIdPrefix}-copy-markdown`}
          sx={{ '--IconButton-size': '28px' }}
        >
          {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
        </IconButton>
      </Tooltip>
      {showFloat && (
        <Tooltip title="Float" disableInteractive>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setSessionLayout({ layout: 'floatingChat', previousLayout: activeLayout })}
            data-testid={`${testIdPrefix}-float`}
            sx={{ '--IconButton-size': '28px' }}
          >
            <OpenInNewIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title="Dock right" disableInteractive>
        <IconButton
          size="sm"
          variant={activeLayout === 'dockRight' ? 'soft' : 'plain'}
          color={activeLayout === 'dockRight' ? 'primary' : 'neutral'}
          onClick={() => setSessionLayout({ layout: 'dockRight' })}
          data-testid={`${testIdPrefix}-dock-right`}
          sx={{ '--IconButton-size': '28px' }}
        >
          <VerticalSplitIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Tooltip title="Dock bottom" disableInteractive>
        <IconButton
          size="sm"
          variant={activeLayout === 'dockBottom' ? 'soft' : 'plain'}
          color={activeLayout === 'dockBottom' ? 'primary' : 'neutral'}
          onClick={() => setSessionLayout({ layout: 'dockBottom' })}
          data-testid={`${testIdPrefix}-dock-bottom`}
          sx={{ '--IconButton-size': '28px' }}
        >
          <HorizontalSplitIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </>
  );
};

export default ChatPanelControls;

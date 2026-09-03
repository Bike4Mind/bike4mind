'use client';

import React from 'react';
import { IconButton, Option, Select, Tooltip, Typography } from '@mui/joy';
import { selectClasses } from '@mui/joy/Select';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { menuSurfaceSx } from '@client/app/components/layouts/Notebook/Sidenav/menuSurfaceSx';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useCopySessionMarkdown } from './useCopySessionMarkdown';

/**
 * Square chrome button for a panel header. Exported so surfaces that contribute their
 * own buttons to this header cluster stay the same shape as the ones defined here.
 */
export const chatHeaderToolButtonSx = {
  // Both axes pinned: Joy sizes an IconButton off --IconButton-size through
  // minWidth/minHeight, which would otherwise win over a bare width/height.
  width: '32px',
  height: '32px',
  minWidth: '32px',
  minHeight: '32px',
  borderRadius: '8px',
} as const;

type LayoutChoice = 'dockRight' | 'dockBottom' | 'floatingChat';

const LAYOUT_LABELS: Record<LayoutChoice, string> = {
  // 'dockRight' is the persisted layout name, kept because it is stored per user; the split
  // row renders that pane on the LEFT (see SessionContainer), so the label says left.
  dockRight: 'Dock left',
  dockBottom: 'Dock bottom',
  floatingChat: 'Float',
};

interface ChatPanelControlsProps {
  /** data-testid prefix, e.g. 'docked-chat' or 'floating-chat' */
  testIdPrefix: string;
  /** Current docked layout; preselected in the menu. Omit in the floating window. */
  activeLayout?: 'dockRight' | 'dockBottom';
  /** Offer "Float" in the menu (docked panels only - the floating window is already there). */
  showFloat?: boolean;
}

/**
 * The window-control cluster shared by DockedChatPanel and FloatingChatWindow: the
 * layout menu (dock directions plus, where the panel offers it, Float) followed by
 * copy-as-markdown. Panel-specific buttons (Hide chat, Close) stay in the panels.
 */
const ChatPanelControls: React.FC<ChatPanelControlsProps> = ({ testIdPrefix, activeLayout, showFloat = false }) => {
  const { copyMarkdown, copied } = useCopySessionMarkdown();

  return (
    <>
      <Select
        size="sm"
        variant="outlined"
        color="neutral"
        value={activeLayout ?? null}
        onChange={(_, value) => value && setSessionLayout({ layout: value })}
        // The floating window passes no activeLayout, so nothing matches an Option and Joy
        // leaves the button blank rather than falling back. Say what the control is.
        placeholder="Layout"
        indicator={<ExpandMoreIcon sx={{ fontSize: 18 }} />}
        renderValue={option => (
          <Typography noWrap level="body-sm" textColor="inherit" sx={{ minWidth: 0 }}>
            {option ? LAYOUT_LABELS[option.value as LayoutChoice] : 'Layout'}
          </Typography>
        )}
        slotProps={{
          button: { 'data-testid': `${testIdPrefix}-layout-select-btn` },
          listbox: {
            'data-testid': `${testIdPrefix}-layout-listbox`,
            sx: theme => ({
              ...menuSurfaceSx(theme),
              borderRadius: '8px',
              // minWidth, not width: Joy's Select popper writes an inline width on this
              // element from the anchor's own box, and an inline style beats any class.
              minWidth: 180,
              maxHeight: 360,
              overflowY: 'auto',
              // The app's own 4px thumb (sidenav, Data Lake tree) rather than the platform
              // bar, which lands a chunky light-grey rail on the dark menu.
              ...scrollbarStyles,
              '--List-padding': '8px',
              '--List-radius': '8px',
              '--List-gap': '4px',
              '--ListItem-radius': '8px',
              // Same hover and selected grounds as the app's other menus instead of Joy's
              // default primary fill. Joy paints its hover from --variant-plainHoverBg, so
              // pointing the variable at the colour is what actually wins - a bare :hover
              // rule does not.
              '& [role="option"]': {
                borderRadius: '8px',
                transition: 'background 0.15s',
                '--variant-plainHoverBg': theme.palette.notebooklist.hoverBg,
                '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
                '&[aria-selected="true"]': {
                  backgroundColor: theme.palette.notebooklist.focusedBackground,
                  fontWeight: 600,
                  // Joy tints a selected Option with the primary palette; the row is already
                  // marked by its ground, so the text stays ordinary ink.
                  color: 'inherit',
                  '&:hover': { backgroundColor: theme.palette.notebooklist.focusedBackground },
                },
                '&:focus-visible': {
                  outline: `2px solid ${theme.palette.primary[500]}`,
                  outlineOffset: '-2px',
                },
              },
            }),
          },
        }}
        data-testid={`${testIdPrefix}-layout-select`}
        sx={{
          maxWidth: 220,
          fontWeight: 400,
          gap: '8px',
          // The chevron points at where the list is: down when it is closed, up while it is
          // open, turning rather than swapping so the two read as one control.
          [`& .${selectClasses.indicator}`]: { transition: 'transform 0.2s ease' },
          [`&.${selectClasses.expanded} .${selectClasses.indicator}`]: { transform: 'rotate(-180deg)' },
        }}
      >
        <Option value="dockRight" data-testid={`${testIdPrefix}-dock-right`}>
          {LAYOUT_LABELS.dockRight}
        </Option>
        <Option value="dockBottom" data-testid={`${testIdPrefix}-dock-bottom`}>
          {LAYOUT_LABELS.dockBottom}
        </Option>
        {showFloat && (
          <Option value="floatingChat" data-testid={`${testIdPrefix}-float`}>
            {LAYOUT_LABELS.floatingChat}
          </Option>
        )}
      </Select>
      <Tooltip title={copied ? 'Copied!' : 'Copy chat as Markdown'} disableInteractive>
        <IconButton
          size="md"
          variant="outlined"
          color={copied ? 'success' : 'neutral'}
          onClick={copyMarkdown}
          aria-label="Copy chat as Markdown"
          data-testid={`${testIdPrefix}-copy-markdown`}
          sx={chatHeaderToolButtonSx}
        >
          {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
    </>
  );
};

export default ChatPanelControls;

import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import { CheckIcon, CubeIcon, GlobeIcon, PanesIcon, PhoneIcon, SearchIcon, TerminalIcon } from './icons';

export type PaneId = 'terminal' | 'browser' | 'simulator' | 'model';

/** One pane the header can open, as ChatShell knows it right now. */
export interface PaneControl {
  id: PaneId;
  /** Whether the pane is on screen, however it got there - the user or the assistant. */
  open: boolean;
  /** Why it cannot be opened right now; absent when it can. */
  unavailableReason?: string;
  onToggle(): void;
}

interface PaneInfo {
  name: string;
  icon: ReactNode;
  /** Only shortcuts that are actually bound - see terminalPanelState.ts isTerminalToggle. */
  shortcut?: string;
  /** The header button's testid, unchanged from when every pane had its own button. */
  buttonTestId: string;
  showLabel: string;
  hideLabel: string;
}

const PANES: Record<PaneId, PaneInfo> = {
  terminal: {
    name: 'Terminal',
    icon: <TerminalIcon />,
    shortcut: 'Ctrl+`',
    buttonTestId: 'chat-toggle-terminal-btn',
    showLabel: 'Show the terminal',
    hideLabel: 'Hide the terminal',
  },
  browser: {
    name: 'Browser',
    icon: <GlobeIcon />,
    buttonTestId: 'chat-toggle-browser-btn',
    showLabel: 'Show the browser',
    hideLabel: 'Hide the browser',
  },
  simulator: {
    name: 'iOS Simulator',
    icon: <PhoneIcon />,
    buttonTestId: 'chat-toggle-simulator-btn',
    showLabel: 'Show the iOS Simulator',
    hideLabel: 'Hide the iOS Simulator',
  },
  model: {
    name: '3D model',
    icon: <CubeIcon />,
    buttonTestId: 'chat-toggle-model-btn',
    showLabel: 'Show the 3D model',
    hideLabel: 'Hide the 3D model',
  },
};

const PANE_ORDER: readonly PaneId[] = ['terminal', 'browser', 'simulator', 'model'];

/** The panes in the header's fixed order, whatever order they were opened or listed in. */
export function inPaneOrder<T extends { id: PaneId }>(panes: readonly T[]): T[] {
  return [...panes].sort((a, b) => PANE_ORDER.indexOf(a.id) - PANE_ORDER.indexOf(b.id));
}

const withShortcut = (label: string, shortcut: string | undefined) => (shortcut ? `${label} (${shortcut})` : label);

/**
 * A toggle in the header for every pane that is open, so closing one is a single click. Driven by
 * the panes' own open state, so a pane the assistant opened gets its button too.
 *
 * Every tooltip here and the menu below open bottom-end from inside the reading column: a popup
 * reaching over the browser pane would be drawn behind its native page - see agentBrowser.ts.
 */
export function OpenPaneButtons({ panes }: { panes: readonly PaneControl[] }) {
  return (
    <>
      {inPaneOrder(panes.filter(pane => pane.open)).map(pane => {
        const info = PANES[pane.id];
        return (
          <Tooltip
            key={pane.id}
            size="sm"
            variant="soft"
            placement="bottom-end"
            title={withShortcut(info.hideLabel, info.shortcut)}
          >
            <IconButton
              size="sm"
              variant="soft"
              color="neutral"
              aria-pressed
              aria-label={info.hideLabel}
              onClick={pane.onToggle}
              data-testid={info.buttonTestId}
            >
              {info.icon}
            </IconButton>
          </Tooltip>
        );
      })}
    </>
  );
}

/**
 * One menu for the panes beside the conversation, plus the session's local-history status, which
 * is a state rather than an action and so reads as a line here instead of a button in the row.
 *
 * Panes that cannot exist here (the simulator off macOS, the 3D model outside a Code session) are
 * left out by the caller; ones that only need a conversation stay listed, disabled, saying so.
 */
export function PanesMenu({ panes, historyOn }: { panes: readonly PaneControl[]; historyOn: boolean }) {
  return (
    <Dropdown>
      <Tooltip size="sm" variant="soft" placement="bottom-end" title="Panes">
        <MenuButton
          slots={{ root: IconButton }}
          slotProps={{ root: { size: 'sm', variant: 'plain', color: 'neutral', 'data-testid': 'chat-panes-menu-btn' } }}
          aria-label="Panes"
        >
          <PanesIcon />
        </MenuButton>
      </Tooltip>
      <Menu size="sm" placement="bottom-end" sx={{ minWidth: 240 }} data-testid="chat-panes-menu">
        {inPaneOrder(panes).map(pane => {
          const info = PANES[pane.id];
          const disabled = pane.unavailableReason !== undefined;
          return (
            <MenuItem
              key={pane.id}
              role="menuitemcheckbox"
              aria-checked={pane.open}
              selected={pane.open}
              disabled={disabled}
              onClick={pane.onToggle}
              data-testid={`chat-panes-menu-${pane.id}-item`}
            >
              <ListItemDecorator>{info.icon}</ListItemDecorator>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography level="body-sm" textColor="inherit">
                  {info.name}
                </Typography>
                {disabled && (
                  <Typography level="body-xs" textColor="text.tertiary">
                    {pane.unavailableReason}
                  </Typography>
                )}
              </Box>
              {info.shortcut && (
                <Typography level="body-xs" textColor="text.tertiary" sx={{ fontFamily: 'monospace' }}>
                  {info.shortcut}
                </Typography>
              )}
              <Box
                component="span"
                sx={{ display: 'inline-flex', width: 16, visibility: pane.open ? 'visible' : 'hidden' }}
              >
                <CheckIcon />
              </Box>
            </MenuItem>
          );
        })}
        {historyOn && (
          <>
            <ListDivider />
            <Box
              role="note"
              aria-label="Local history is on"
              data-testid="chat-history-indicator"
              sx={{ display: 'flex', alignItems: 'flex-start', gap: 1, px: 1.5, py: 0.75, color: 'text.tertiary' }}
            >
              <Box component="span" sx={{ display: 'inline-flex', pt: 0.25 }}>
                <SearchIcon />
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography level="body-xs" textColor="text.secondary">
                  Local history is on
                </Typography>
                <Typography level="body-xs" textColor="text.tertiary">
                  Change it in the browser&apos;s ... menu.
                </Typography>
              </Box>
            </Box>
          </>
        )}
      </Menu>
    </Dropdown>
  );
}

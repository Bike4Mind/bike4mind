import { useState } from 'react';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Dropdown from '@mui/joy/Dropdown';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Modal from '@mui/joy/Modal';
import ModalDialog from '@mui/joy/ModalDialog';
import Typography from '@mui/joy/Typography';
import type { BrowserTabSummary } from '@shared/ipc';
import { tabsToClose, type BrowserTabCloseAction, type BrowserTabUse } from './browserTabClose';

export interface BrowserTabMenuRequest {
  tabId: number;
  x: number;
  y: number;
}

interface InUseTab {
  tab: BrowserTabSummary;
  use: BrowserTabUse;
}

const ACTIONS: { action: BrowserTabCloseAction; label: string; testId: string }[] = [
  { action: 'this', label: 'Close tab', testId: 'browser-tab-menu-close-btn' },
  { action: 'others', label: 'Close other tabs', testId: 'browser-tab-menu-close-others-btn' },
  { action: 'right', label: 'Close tabs to the right', testId: 'browser-tab-menu-close-right-btn' },
  { action: 'all', label: 'Close all tabs', testId: 'browser-tab-menu-close-all-btn' },
];

const USE_LABEL: Record<BrowserTabUse, string> = {
  agent: 'the agent is using this page',
  'dev-server': 'dev server preview',
};

/**
 * The tab strip's right-click menu, and the confirmation it asks for before closing a tab that
 * is in use. Tabs not in use close straight away.
 *
 * `inUse` is read when an action is picked rather than when the menu opens, so a tab the agent
 * starts using while the menu is up still asks.
 */
export function BrowserTabMenu({
  tabs,
  request,
  label,
  inUse,
  onDismiss,
  onCloseTabs,
}: {
  tabs: readonly BrowserTabSummary[];
  request: BrowserTabMenuRequest | null;
  label: (tab: BrowserTabSummary) => string;
  inUse: (tab: BrowserTabSummary) => BrowserTabUse | null;
  onDismiss: () => void;
  onCloseTabs: (ids: number[]) => void;
}) {
  const [confirm, setConfirm] = useState<{ ids: number[]; busy: InUseTab[] } | null>(null);

  const pick = (action: BrowserTabCloseAction) => {
    if (!request) return;
    const closing = tabsToClose(tabs, request.tabId, action);
    onDismiss();
    if (closing.length === 0) return;
    const ids = closing.map(tab => tab.id);
    const busy = closing.flatMap(tab => {
      const use = inUse(tab);
      return use ? [{ tab, use }] : [];
    });
    if (busy.length === 0) onCloseTabs(ids);
    else setConfirm({ ids, busy });
  };

  const disabled = (action: BrowserTabCloseAction) =>
    request !== null && action !== 'this' && action !== 'all' && tabsToClose(tabs, request.tabId, action).length === 0;

  const total = confirm?.ids.length ?? 0;

  return (
    <>
      {/* Anchored to a zero-size point at the cursor, since a Joy Menu has to hang off a button. */}
      <Dropdown open={request !== null} onOpenChange={(_event, open) => !open && onDismiss()}>
        <MenuButton
          slots={{ root: 'span' }}
          slotProps={{
            root: {
              'aria-hidden': true,
              tabIndex: -1,
              style: {
                position: 'fixed',
                left: request?.x ?? 0,
                top: request?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              },
            },
          }}
        />
        <Menu size="sm" placement="bottom-start" data-testid="browser-tab-menu">
          {ACTIONS.map(({ action, label: text, testId }) => (
            <MenuItem key={action} disabled={disabled(action)} onClick={() => pick(action)} data-testid={testId}>
              {text}
            </MenuItem>
          ))}
        </Menu>
      </Dropdown>

      {confirm && (
        <Modal open onClose={() => setConfirm(null)}>
          <ModalDialog data-testid="browser-tab-close-confirm-dialog" sx={{ maxWidth: 420 }}>
            <DialogTitle>{total === 1 ? 'Close this tab?' : `Close ${total} tabs?`}</DialogTitle>
            <DialogContent>
              <Typography level="body-sm">
                {confirm.busy.length === 1 ? 'This tab is in use:' : `${confirm.busy.length} of these tabs are in use:`}
              </Typography>
              <List size="sm" marker="disc" data-testid="browser-tab-close-confirm-list">
                {confirm.busy.map(({ tab, use }) => (
                  <ListItem key={tab.id} data-testid="browser-tab-close-confirm-item" data-tab-id={tab.id}>
                    <Typography level="body-sm">
                      <Typography fontWeight="md">{label(tab)}</Typography> ({USE_LABEL[use]})
                    </Typography>
                  </ListItem>
                ))}
              </List>
            </DialogContent>
            <DialogActions>
              <Button
                color="danger"
                onClick={() => {
                  onCloseTabs(confirm.ids);
                  setConfirm(null);
                }}
                data-testid="browser-tab-close-confirm-btn"
              >
                {total === 1 ? 'Close tab' : 'Close tabs'}
              </Button>
              <Button
                variant="outlined"
                color="neutral"
                onClick={() => setConfirm(null)}
                data-testid="browser-tab-close-cancel-btn"
              >
                Cancel
              </Button>
            </DialogActions>
          </ModalDialog>
        </Modal>
      )}
    </>
  );
}

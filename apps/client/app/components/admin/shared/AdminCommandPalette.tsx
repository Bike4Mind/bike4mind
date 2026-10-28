import { useEffect, useRef, useState } from 'react';
import { Box, Button, Input, Modal, ModalClose, ModalDialog, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { AdminTab } from '../adminSidebarConfig';
import { adminTabToSlug } from '../adminTabSlugs';
import { parseUserId } from '../Users/usersTabSearch';
import { adminFocusScope, adminSurface } from './adminStyles';
import { focusAdminSearch, isAdminChordEvent, isAdminOverlayOpen, isAdminShortcutEvent } from './adminKeyboard';

export type AdminCommand = {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** Keep it out of the visible button strip when the page already shows its own control for it. */
  paletteOnly?: boolean;
  run: () => void;
};

const shortcuts = [
  ['Cmd/Ctrl+K', 'Open command palette'],
  ['/', 'Focus the current page search'],
  ['x', 'Toggle selection of the focused table row'],
  ['c', 'Adjust credits on a user profile'],
  ['s', 'Suspend the account on a user profile'],
  ['Cmd/Ctrl+S', 'Save the settings editor you are working in'],
  ['?', 'Show keyboard shortcuts'],
];

export function AdminCommandPalette({
  commands = [],
  onNavigate,
  onOpenHelp,
}: {
  commands?: AdminCommand[];
  onNavigate?: (tab: AdminTab) => void;
  onOpenHelp?: () => void;
}) {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const commandTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(commandTimer.current), []);
  const [open, setOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const go = (tab: AdminTab) =>
    onNavigate ? onNavigate(tab) : navigate({ to: '/admin', search: { tab: adminTabToSlug(tab) } });
  const navigation: AdminCommand[] = [
    { id: 'users', label: 'Find users', run: () => go(AdminTab.Users) },
    { id: 'organizations', label: 'Find organizations', run: () => go(AdminTab.Organizations) },
    { id: 'settings', label: 'Open admin settings', run: () => go(AdminTab.AdminSettings) },
    { id: 'audit', label: 'Open audit log', run: () => go(AdminTab.AuditLog) },
    ...(onOpenHelp ? [{ id: 'help', label: 'Open Help Center', run: onOpenHelp }] : []),
  ];
  const userId = parseUserId(query.trim().toLowerCase());
  const results: AdminCommand[] = [
    ...(userId
      ? [
          {
            id: 'user-id',
            label: `Open user ${userId}`,
            run: () => navigate({ to: '/admin/users/$userId', params: { userId } }),
          },
        ]
      : []),
    ...[...commands, ...navigation].filter(command => command.label.toLowerCase().includes(query.trim().toLowerCase())),
  ];
  const selected = results[Math.min(active, Math.max(0, results.length - 1))];
  const execute = (command: AdminCommand) => {
    if (command.disabled) return;
    setOpen(false);
    // Let the modal restore focus before a command focuses another control or opens a dialog.
    window.clearTimeout(commandTimer.current);
    commandTimer.current = window.setTimeout(command.run, 0);
  };

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (isAdminOverlayOpen()) return;
      const key = event.key.toLowerCase();
      if (isAdminChordEvent(event) && key === 'k' && !event.shiftKey) {
        event.preventDefault();
        setQuery('');
        setActive(0);
        setOpen(true);
        return;
      }
      if (!isAdminShortcutEvent(event) || event.metaKey || event.ctrlKey) return;
      if (key === '?') {
        event.preventDefault();
        setHelp(true);
      } else if (key === '/') {
        const scope = rootRef.current?.closest<HTMLElement>('[data-admin-surface]');
        if (scope && focusAdminSearch(scope)) event.preventDefault();
      } else if (!event.shiftKey) {
        const command = commands.find(item => item.shortcut === key);
        if (command && !command.disabled) {
          event.preventDefault();
          command.run();
        }
      }
    };
    // Capture phase so the page search wins `/` over the sidebar filter's bubble listener (AdminSidebarNav),
    // which then only takes `/` when this page has no visible search.
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [commands]);

  useEffect(() => {
    if (open) document.getElementById(`admin-command-${selected?.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, selected?.id]);

  return (
    <Box ref={rootRef} sx={{ ...adminFocusScope, p: 1 }}>
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button
          variant="outlined"
          color="neutral"
          size="sm"
          data-testid="admin-command-open-btn"
          aria-keyshortcuts="Meta+k Control+k"
          onClick={() => {
            setQuery('');
            setActive(0);
            setOpen(true);
          }}
        >
          Commands (Cmd/Ctrl+K)
        </Button>
        <Button
          variant="plain"
          color="neutral"
          size="sm"
          data-testid="admin-shortcuts-open-btn"
          onClick={() => setHelp(true)}
        >
          Keyboard shortcuts (?)
        </Button>
        {commands
          .filter(command => !command.paletteOnly)
          .map(command => (
            <Button
              key={command.id}
              variant="plain"
              color="neutral"
              size="sm"
              data-testid={`admin-command-${command.id}-btn`}
              disabled={command.disabled}
              onClick={command.run}
            >
              {command.label}
              {command.shortcut ? ` (${command.shortcut})` : ''}
            </Button>
          ))}
      </Stack>
      <Modal open={open} onClose={() => setOpen(false)}>
        <ModalDialog
          aria-labelledby="admin-command-title"
          aria-describedby="admin-command-description"
          sx={{ ...adminSurface, width: 'min(36rem, 90vw)' }}
        >
          <ModalClose data-testid="admin-command-close-btn" aria-label="Close command palette" />
          <Typography id="admin-command-title" level="title-lg">
            Admin commands
          </Typography>
          <Typography id="admin-command-description" level="body-sm">
            Navigate or open a current-record action. Paste a user ID to open its profile.
          </Typography>
          <Input
            autoFocus
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setActive(0);
            }}
            slotProps={{
              input: {
                role: 'combobox',
                'aria-label': 'Search admin commands or user ID',
                'aria-expanded': true,
                'aria-autocomplete': 'list',
                'aria-controls': 'admin-command-results',
                'aria-activedescendant': selected ? `admin-command-${selected.id}` : undefined,
                'data-testid': 'admin-search-input',
              },
            }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.repeat) return;
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setActive(index =>
                  results.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length : 0
                );
              } else if (event.key === 'Enter' && selected && !selected.disabled) {
                event.preventDefault();
                execute(selected);
              }
            }}
          />
          <Box
            id="admin-command-results"
            role="listbox"
            aria-label="Admin commands"
            sx={{ overflowY: 'auto', maxHeight: '45vh' }}
          >
            {results.map(command => (
              <Button
                key={command.id}
                id={`admin-command-${command.id}`}
                role="option"
                aria-selected={selected?.id === command.id}
                variant={selected?.id === command.id ? 'soft' : 'plain'}
                color="neutral"
                fullWidth
                data-testid="admin-search-result"
                disabled={command.disabled}
                onClick={() => execute(command)}
                sx={{ justifyContent: 'flex-start' }}
              >
                {command.label}
              </Button>
            ))}
          </Box>
          {!results.length && (
            <Typography role="status">No matching commands. Use the Users or Organizations page search.</Typography>
          )}
          <Typography level="body-xs">
            Name, email, organization ID and key-prefix lookup require the global admin search backend, which is not
            available yet. No entity search is sent from this palette.
          </Typography>
        </ModalDialog>
      </Modal>
      <Modal open={help} onClose={() => setHelp(false)}>
        <ModalDialog aria-labelledby="admin-shortcuts-title" sx={adminSurface}>
          <ModalClose data-testid="admin-shortcuts-close-btn" aria-label="Close keyboard shortcuts" />
          <Typography id="admin-shortcuts-title" level="title-lg">
            Admin keyboard shortcuts
          </Typography>
          {shortcuts.map(([key, label]) => (
            <Typography key={key} level="body-sm">
              <kbd>{key}</kbd>: {label}
            </Typography>
          ))}
          <Typography level="body-xs">
            Single-key shortcuts do not run in inputs or editable text. No shortcut runs while a menu or dialog is open.
            Actions still require their normal preview, reason and confirmation.
          </Typography>
        </ModalDialog>
      </Modal>
    </Box>
  );
}

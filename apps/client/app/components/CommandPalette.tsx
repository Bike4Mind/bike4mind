import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Box, Input, Modal, ModalDialog, Typography } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import AddCommentIcon from '@mui/icons-material/AddComment';
import HomeIcon from '@mui/icons-material/Home';
import FolderIcon from '@mui/icons-material/Folder';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import GroupsIcon from '@mui/icons-material/Groups';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import ExtensionIcon from '@mui/icons-material/Extension';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { useCommandPalette } from '@client/app/hooks/useCommandPalette';
import { openHelpPanel } from '@client/app/hooks/useHelpPanel';
import { useNotebookSearch } from '@client/app/contexts/NotebookSearchContext';
import { useTranslation } from 'react-i18next';

interface PaletteAction {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  keywords: string[];
  onSelect: () => void;
}

const CommandPalette = () => {
  const { open, setOpen } = useCommandPalette();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const setNotebookSearch = useNotebookSearch(s => s.setSearch);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastNavSourceRef = useRef<'keyboard' | 'mouse'>('keyboard');

  const actions: PaletteAction[] = useMemo(
    () => [
      {
        id: 'new-chat',
        label: 'New Chat',
        description: 'Start a new notebook',
        icon: <AddCommentIcon />,
        keywords: ['new', 'chat', 'notebook', 'create', 'start'],
        onSelect: () => navigate({ to: '/new' }),
      },
      {
        id: 'home',
        label: 'Go to Home',
        description: 'Open the home dashboard',
        icon: <HomeIcon />,
        keywords: ['home', 'dashboard', 'main'],
        onSelect: () => navigate({ to: '/' }),
      },
      {
        id: 'projects',
        label: 'Projects',
        description: 'Browse all projects',
        icon: <FolderIcon />,
        keywords: ['projects', 'folder', 'organize'],
        onSelect: () => navigate({ to: '/projects' }),
      },
      {
        id: 'agents',
        label: 'Agents',
        description: 'Browse and manage agents',
        icon: <SmartToyIcon />,
        keywords: ['agents', 'ai', 'bot', 'assistant'],
        onSelect: () => navigate({ to: '/agents' }),
      },
      {
        id: 'skills',
        label: t('skills.title', 'Skills'),
        description: t('skills.command_palette_description', 'Manage reusable instruction templates'),
        icon: <ExtensionIcon />,
        keywords: ['skills', 'slash', 'commands', 'templates', 'prompts'],
        onSelect: () => navigate({ to: '/skills' }),
      },
      {
        id: 'organizations',
        label: 'Organizations',
        description: 'Manage organizations and teams',
        icon: <GroupsIcon />,
        keywords: ['organizations', 'teams', 'org', 'workspace'],
        onSelect: () => navigate({ to: '/organizations' }),
      },
      {
        id: 'profile',
        label: 'Profile',
        description: 'View your profile',
        icon: <PersonIcon />,
        keywords: ['profile', 'account', 'me', 'user'],
        onSelect: () => navigate({ to: '/profile' }),
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Open account settings',
        icon: <SettingsIcon />,
        keywords: ['settings', 'preferences', 'config', 'account'],
        onSelect: () => navigate({ to: '/profile', search: { tab: 'settings' } }),
      },
      {
        id: 'keyboard-shortcuts',
        label: 'Keyboard Shortcuts',
        description: 'View all keyboard shortcuts',
        icon: <KeyboardIcon />,
        keywords: ['keyboard', 'shortcuts', 'hotkeys', 'keys'],
        onSelect: () => openHelpPanel('features/keyboard-shortcuts'),
      },
      {
        id: 'search-notebooks',
        label: query.startsWith('> ') && query.length > 2 ? `Search: "${query.slice(2)}"` : 'Search Notebooks',
        description: query.startsWith('> ') ? undefined : 'Type "> " then your query to search notebooks',
        icon: <SearchIcon />,
        keywords: ['search', 'find', 'notebook', 'chat'],
        onSelect: () => {
          const term = query.startsWith('> ') ? query.slice(2).trim() : '';
          if (term) setNotebookSearch(term);
          navigate({ to: '/' });
        },
      },
    ],
    [navigate, setNotebookSearch, query, t]
  );

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q || q === '>') return actions;
    if (q.startsWith('> ')) {
      return actions.filter(a => a.id === 'search-notebooks');
    }
    return actions.filter(
      a =>
        a.label.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.keywords.some(k => k.includes(q))
    );
  }, [actions, query]);

  // Reset state when opening
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [open]);

  // Keep active index in bounds when filtered list changes
  useEffect(() => {
    setActiveIndex(i => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Scroll active item into view only when navigating via keyboard.
  // Mouse hover sets activeIndex too, but shouldn't fight the user's scroll position.
  useEffect(() => {
    if (lastNavSourceRef.current !== 'keyboard') return;
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      lastNavSourceRef.current = 'keyboard';
      setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      lastNavSourceRef.current = 'keyboard';
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[activeIndex]?.onSelect();
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function handleSelect(action: PaletteAction) {
    action.onSelect();
    setOpen(false);
  }

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'center', pt: '15vh' }}
    >
      <ModalDialog
        sx={{
          p: 0,
          width: '100%',
          maxWidth: 560,
          overflow: 'hidden',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '12px',
          boxShadow: 'lg',
        }}
      >
        {/* Search input */}
        <Box sx={{ px: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Input
            slotProps={{
              input: {
                ref: inputRef,
                role: 'combobox',
                'aria-label': 'Search commands',
                'aria-expanded': true,
                'aria-controls': 'command-palette-listbox',
                'aria-activedescendant': filtered.length > 0 ? `palette-item-${filtered[activeIndex]?.id}` : undefined,
                'aria-autocomplete': 'list',
              },
            }}
            startDecorator={<SearchIcon sx={{ color: 'neutral.400', fontSize: 20 }} />}
            placeholder='Search or type "> " to search notebooks…'
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            variant="plain"
            sx={{ fontSize: 15, '--Input-focusedHighlight': 'none', boxShadow: 'none' }}
          />
        </Box>

        {/* Results list */}
        <Box
          id="command-palette-listbox"
          component="ul"
          role="listbox"
          aria-label="Commands"
          ref={listRef}
          sx={{ listStyle: 'none', m: 0, p: 0.75, maxHeight: 360, overflowY: 'auto' }}
        >
          {filtered.length === 0 ? (
            <Box sx={{ px: 2, py: 3, textAlign: 'center' }}>
              <Typography level="body-sm" sx={{ color: 'neutral.400' }}>
                No results for &ldquo;{query}&rdquo;
              </Typography>
            </Box>
          ) : (
            filtered.map((action, i) => (
              <Box
                key={action.id}
                id={`palette-item-${action.id}`}
                component="li"
                role="option"
                aria-selected={i === activeIndex}
                onClick={() => handleSelect(action)}
                onMouseEnter={() => {
                  lastNavSourceRef.current = 'mouse';
                  setActiveIndex(i);
                }}
                sx={theme => ({
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.5,
                  px: 1.5,
                  py: 1,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  bgcolor: i === activeIndex ? theme.palette.neutral.softBg : 'transparent',
                  '&:hover': { bgcolor: theme.palette.neutral.softBg },
                })}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    borderRadius: '8px',
                    bgcolor: 'background.level2',
                    color: 'neutral.500',
                    flexShrink: 0,
                    '& svg': { fontSize: 18 },
                  }}
                >
                  {action.icon}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography level="body-sm" sx={{ fontWeight: 500 }}>
                    {action.label}
                  </Typography>
                  {action.description && (
                    <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                      {action.description}
                    </Typography>
                  )}
                </Box>
                {i === activeIndex && (
                  <Box sx={{ ml: 'auto', flexShrink: 0 }}>
                    <Typography
                      level="body-xs"
                      sx={{
                        px: 0.75,
                        py: 0.25,
                        borderRadius: '4px',
                        bgcolor: 'background.level2',
                        color: 'neutral.500',
                        border: '1px solid',
                        borderColor: 'divider',
                      }}
                    >
                      ↵
                    </Typography>
                  </Box>
                )}
              </Box>
            ))
          )}
        </Box>

        {/* Footer hint */}
        <Box
          sx={{
            px: 2,
            py: 1,
            borderTop: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            gap: 2,
          }}
        >
          {[
            { key: '↑↓', label: 'navigate' },
            { key: '↵', label: 'select' },
            { key: 'esc', label: 'close' },
          ].map(({ key, label }) => (
            <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography
                level="body-xs"
                sx={{
                  px: 0.75,
                  py: 0.25,
                  borderRadius: '4px',
                  bgcolor: 'background.level2',
                  color: 'neutral.500',
                  border: '1px solid',
                  borderColor: 'divider',
                  fontFamily: 'monospace',
                }}
              >
                {key}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'neutral.400' }}>
                {label}
              </Typography>
            </Box>
          ))}
        </Box>
      </ModalDialog>
    </Modal>
  );
};

export default CommandPalette;

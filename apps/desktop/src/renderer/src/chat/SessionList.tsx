import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatSessionMode, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { groupSessions, orderedSessions, type ProjectGroup } from './grouping';
import { ArtifactIcon, ChevronIcon, MoreIcon, PanelLeftIcon, PlusIcon, SearchIcon, SlidersIcon } from './icons';
import { ModeSwitcher } from './ModeSwitcher';
import { SessionBadge } from './SessionBadge';

export const SIDEBAR_WIDTH = 280;

/**
 * Shared by every session list in the sidebar so the four of them cannot drift apart.
 * The height comes down through --ListItem-minHeight because that is what governs here:
 * a row is one line of 0.8125rem text, well under Joy's 2rem floor, so --ListItem-paddingY
 * never reaches it on its own. 28px still draws a band rather than a stripe and is still a
 * comfortable pointer target across the full 280px. --List-padding replaces the 0.25rem Joy
 * insets every list by, which also brings a row's content into line with the group header
 * above it - both now start 16px from the sidebar's edge.
 */
const SESSION_LIST_SX = {
  '--ListItem-radius': '6px',
  '--ListItem-minHeight': '28px',
  '--ListItem-paddingY': '2px',
  '--List-padding': '0px',
  gap: 0.25,
};

/** Both kinds of group header, so a project group and a plain label sit identically. */
const GROUP_HEADER_SX = { px: 1, pt: 1, pb: 0.25 };

/** Joy's sm IconButton, which is what the row's menu button is. */
const MENU_BUTTON_WIDTH = '2rem';

/**
 * Alpha only - the colour is immaterial - so the same declaration holds against the row's
 * default, hovered and selected backgrounds in either theme. A gradient Box laid over the
 * title would have to match each of those and would seam on the ones it got wrong.
 */
const TITLE_FADE = 'linear-gradient(to right, #000 calc(100% - 24px), transparent)';

/** A primary nav entry: leading icon, label, and whatever trailing affordance it needs. */
export function NavItem({
  icon,
  label,
  onClick,
  end,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  end?: ReactNode;
  testId: string;
}) {
  return (
    <Button
      fullWidth
      size="sm"
      variant="plain"
      color="neutral"
      startDecorator={icon}
      endDecorator={end}
      onClick={onClick}
      sx={{ justifyContent: 'flex-start', fontWeight: 'md', '--Button-gap': '10px' }}
      data-testid={testId}
    >
      <Box sx={{ flex: 1, textAlign: 'left' }}>{label}</Box>
    </Button>
  );
}

interface RowProps {
  session: ChatSessionSummary;
  activeId: string | null;
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  onToggleArchived: (session: ChatSessionSummary) => void;
}

/**
 * Whether the title is wider than the box drawing it. Watched rather than measured once:
 * the row takes 2rem away from the title when its menu button appears and hands it back
 * when it goes, so the answer changes without the text changing.
 */
function useTitleClipped(title: string) {
  const ref = useRef<HTMLElement>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    // Both sides are whole pixels, so a box holding its text exactly can still report one
    // more than it fits; a title over by a single pixel is not worth fading.
    const measure = () => setClipped(node.scrollWidth - node.clientWidth > 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [title]);

  return { ref, clipped };
}

function SessionRow({ session, activeId, statuses, onSelect, onDelete, onTogglePin, onToggleArchived }: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const status = statuses.get(session.id) ?? 'done';
  const needsAction = status === 'needs-action';
  const { ref: titleRef, clipped } = useTitleClipped(session.title);

  return (
    <ListItem
      sx={{
        // Hidden until the row is hovered, focused, or its own menu is open. Focus counts as
        // much as hover: revealing on hover alone would put the row's only actions out of
        // reach of the keyboard, and the open menu takes focus into a portal, so it has to
        // hold the row open by itself.
        '--row-actions-opacity': menuOpen ? 1 : 0,
        // Joy's own reservation for an endAction, which it otherwise pins at 2.5rem whether
        // the button is showing or not. Driven by the same three states as the opacity above,
        // so the title owns the whole row until there is actually a button to run under.
        '--ListItem-endActionWidth': menuOpen ? MENU_BUTTON_WIDTH : '0px',
        '&:hover, &:focus-within': {
          '--row-actions-opacity': 1,
          '--ListItem-endActionWidth': MENU_BUTTON_WIDTH,
        },
      }}
      endAction={
        <Box sx={{ opacity: 'var(--row-actions-opacity)', transition: 'opacity 120ms' }}>
          <Dropdown open={menuOpen} onOpenChange={(_event, open) => setMenuOpen(open)}>
            <MenuButton
              slots={{ root: IconButton }}
              slotProps={{
                root: {
                  size: 'sm',
                  variant: 'plain',
                  color: 'neutral',
                  'aria-label': `Options for ${session.title}`,
                  'data-testid': 'chat-session-menu-btn',
                },
              }}
            >
              <MoreIcon />
            </MenuButton>
            <Menu size="sm" placement="bottom-end">
              <MenuItem onClick={() => onTogglePin(session)} data-testid="chat-pin-session-btn">
                {session.pinned ? 'Unpin' : 'Pin'}
              </MenuItem>
              <MenuItem onClick={() => onToggleArchived(session)} data-testid="chat-archive-session-btn">
                {session.archived ? 'Unarchive' : 'Archive'}
              </MenuItem>
              <MenuItem color="danger" onClick={() => onDelete(session.id)} data-testid="chat-delete-session-btn">
                Delete
              </MenuItem>
            </Menu>
          </Dropdown>
        </Box>
      }
    >
      <ListItemButton
        selected={session.id === activeId}
        onClick={() => onSelect(session.id)}
        sx={{
          // Paired with the opacity the button fades in on, so the title's edge travels with
          // the button instead of snapping the moment the pointer lands.
          transition: 'padding-inline-end 120ms',
          ...(needsAction && { boxShadow: 'inset 2px 0 0 var(--joy-palette-warning-solidBg)' }),
        }}
        data-testid="chat-session-item"
        data-session-status={status}
      >
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
          <SessionBadge status={status} />
          {/* Between Joy's body-sm and body-xs: at body-xs the row matches its own group header,
              which is bold, so the header outweighs the content it labels. The weight is spelled
              out because Joy's body-xs level carries fontWeight md, which drew every title
              heavier than the rest of the sidebar - a title is content, not a heading. */}
          <Typography
            ref={titleRef}
            level="body-xs"
            noWrap
            sx={{
              minWidth: 0,
              fontSize: '0.8125rem',
              fontWeight: 'normal',
              // noWrap brings an ellipsis with it; the mask replaces it. Only when the text
              // really is clipped - a fade over the last pixels of a short title reads as a
              // rendering fault.
              textOverflow: 'clip',
              ...(clipped && { WebkitMaskImage: TITLE_FADE, maskImage: TITLE_FADE }),
            }}
          >
            {session.title}
          </Typography>
        </Stack>
      </ListItemButton>
    </ListItem>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography level="body-xs" textColor="text.tertiary" sx={{ ...GROUP_HEADER_SX, fontWeight: 'lg' }}>
      {children}
    </Typography>
  );
}

function ProjectHeader({
  group,
  onCreateInProject,
  onSearch,
  onSettings,
}: {
  group: ProjectGroup;
  onCreateInProject: (group: ProjectGroup) => void;
  onSearch: (group: ProjectGroup) => void;
  onSettings: (group: ProjectGroup) => void;
}) {
  const actions: { label: string; icon: ReactNode; run: () => void; testId: string }[] = [
    {
      label: `New session in ${group.name}`,
      icon: <PlusIcon />,
      run: () => onCreateInProject(group),
      testId: 'project-new-btn',
    },
    { label: `Search ${group.name}`, icon: <SearchIcon />, run: () => onSearch(group), testId: 'project-search-btn' },
    {
      label: `${group.name} settings`,
      icon: <SlidersIcon />,
      run: () => onSettings(group),
      testId: 'project-settings-btn',
    },
  ];

  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', gap: 0.25, ...GROUP_HEADER_SX }}
      data-testid="project-group-header"
    >
      <Tooltip title={group.directory} size="sm" variant="soft" placement="top-start">
        <Typography level="body-xs" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 'lg' }}>
          {group.name}
        </Typography>
      </Tooltip>
      {actions.map(action => (
        <IconButton
          key={action.testId}
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={action.label}
          onClick={action.run}
          data-testid={action.testId}
        >
          {action.icon}
        </IconButton>
      ))}
    </Stack>
  );
}

/**
 * The sidebar: primary nav, a pinned section, then the sessions for the current mode - Code
 * sessions under a header per project, Chat sessions in one flat list - and the account strip.
 *
 * Adapted from Claude Code desktop's layout, with its nav entries dropped rather than shipped
 * as dead links: "Customize" and "More" were removed on the user's instruction. "Artifacts"
 * came back once replies started producing them, and "Customize" once there was an app setting
 * to put in it. New behaves identically in both modes.
 */
export function SessionList({
  sessions,
  mode,
  onModeChange,
  loading,
  activeId,
  statuses,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onOpenArtifacts,
  onCreateInProject,
  onDelete,
  onTogglePin,
  onToggleArchived,
  customize,
  footer,
}: {
  sessions: ChatSessionSummary[];
  mode: ChatSessionMode;
  onModeChange: (mode: ChatSessionMode) => void;
  loading: boolean;
  activeId: string | null;
  /** What each session is doing, pushed from main. Absent means idle. */
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onOpenArtifacts: () => void;
  onCreateInProject: (directory: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  onToggleArchived: (session: ChatSessionSummary) => void;
  /** The app-settings slot under the nav entries, which owns its own expanded state. */
  customize?: ReactNode;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState('');

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(session => session.title.toLowerCase().includes(needle));
  }, [sessions, query]);

  const [archivedOpen, setArchivedOpen] = useState(false);

  const sections = useMemo(() => groupSessions(matching, mode), [matching, mode]);
  const empty =
    sections.pinned.length === 0 &&
    sections.projects.length === 0 &&
    sections.loose.length === 0 &&
    sections.archived.length === 0;

  const ordered = useMemo(() => orderedSessions(sections), [sections]);

  // Read inside the key handler so the listener is bound once rather than rebuilt on every
  // keystroke in the search box, which re-orders this list.
  const target = useRef({ ordered, onSelect, onToggleCollapsed });
  target.current = { ordered, onSelect, onToggleCollapsed };

  /**
   * The modifier plus 1-9 opens the nth row, counted the way the sidebar draws them and
   * filtered the way the search box currently has them. Nothing advertises this any more -
   * the numbered badges went in T10 and the More panel that documented it was removed - but
   * the bindings themselves still work. Bound on the window rather than the sidebar, because
   * a user reaching for it is almost always typing in the composer at the time.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;

      if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        target.current.onToggleCollapsed();
        return;
      }

      // `event.code` rather than `event.key`: on several non-US layouts the digit row only
      // produces a digit with a modifier already applied, and `key` is then a symbol.
      const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
      if (!digit) return;

      const session = target.current.ordered[Number(digit) - 1];
      if (!session) return;
      event.preventDefault();
      target.current.onSelect(session.id);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const rowProps = { activeId, statuses, onSelect, onDelete, onTogglePin, onToggleArchived };

  if (collapsed) {
    return (
      <Stack
        sx={{
          width: 44,
          flexShrink: 0,
          alignItems: 'center',
          borderRight: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.level1',
          height: '100%',
          pt: 1,
        }}
        data-testid="sidebar-rail"
      >
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Show sidebar"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle-btn"
        >
          <PanelLeftIcon />
        </IconButton>
      </Stack>
    );
  }

  return (
    <Stack
      sx={{
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
      data-testid="sidebar"
    >
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, px: 1.5, pt: 1.5, pb: 1 }}>
        <ModeSwitcher mode={mode} onChange={onModeChange} />
        <Box sx={{ flex: 1 }} />
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Hide sidebar"
          onClick={onToggleCollapsed}
          data-testid="sidebar-toggle-btn"
        >
          <PanelLeftIcon />
        </IconButton>
      </Stack>

      <Stack spacing={0.25} sx={{ px: 1, pb: 1 }}>
        {/* One label and one behaviour in both modes: it makes a session and opens nothing.
            A Code session starts unbound and its chip row is where a project is chosen. */}
        <NavItem icon={<PlusIcon />} label="New" onClick={onCreate} testId="chat-new-session-btn" />
        {/* Not scoped to the open session: the list is the server's, so it spans machines and
            outlives the local session files. */}
        <NavItem icon={<ArtifactIcon />} label="Artifacts" onClick={onOpenArtifacts} testId="chat-artifacts-btn" />
        {customize}
        <Box sx={{ px: 0.5, pt: 0.5 }}>
          <Input
            size="sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search conversations"
            startDecorator={<SearchIcon />}
            slotProps={{ input: { 'data-testid': 'chat-search-input' } }}
          />
        </Box>
      </Stack>

      <Box sx={{ overflowY: 'auto', flex: 1, px: 1, pb: 1 }}>
        {loading ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }}>
            Loading conversations...
          </Typography>
        ) : empty ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }} data-testid="chat-sessions-empty">
            {mode === 'code' ? 'No Code sessions yet.' : 'No conversations yet.'}
          </Typography>
        ) : (
          <>
            {sections.pinned.length > 0 && (
              <Box data-testid="sidebar-pinned">
                <SectionLabel>Pinned</SectionLabel>
                <List size="sm" sx={SESSION_LIST_SX}>
                  {sections.pinned.map(session => (
                    <SessionRow key={session.id} session={session} {...rowProps} />
                  ))}
                </List>
              </Box>
            )}

            {sections.projects.map(group => (
              <Box key={group.directory} data-testid="project-group">
                <ProjectHeader
                  group={group}
                  onCreateInProject={target => onCreateInProject(target.directory)}
                  onSearch={target => setQuery(target.name)}
                  onSettings={target => onSelect(target.sessions[0].id)}
                />
                <List size="sm" sx={SESSION_LIST_SX}>
                  {group.sessions.map(session => (
                    <SessionRow key={session.id} session={session} {...rowProps} />
                  ))}
                </List>
              </Box>
            ))}

            {sections.loose.length > 0 && (
              <Box>
                {/* In Code mode these are the sessions with no project yet, and they sit under
                    the project groups - unlabelled they read as belonging to the last one. */}
                {(sections.pinned.length > 0 || sections.projects.length > 0) && (
                  <SectionLabel>{mode === 'code' ? 'No project' : 'Conversations'}</SectionLabel>
                )}
                <List size="sm" sx={SESSION_LIST_SX}>
                  {sections.loose.map(session => (
                    <SessionRow key={session.id} session={session} {...rowProps} />
                  ))}
                </List>
              </Box>
            )}

            {/* Shut by default, and counted on the header: an archived conversation is still
                there to get back, which is the whole difference from deleting one. */}
            {sections.archived.length > 0 && (
              <Box data-testid="sidebar-archived">
                <Button
                  fullWidth
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => setArchivedOpen(open => !open)}
                  endDecorator={<ChevronIcon open={archivedOpen} />}
                  sx={{ justifyContent: 'flex-start', mt: 1, fontWeight: 'md' }}
                  data-testid="sidebar-archived-btn"
                >
                  <Box sx={{ flex: 1, textAlign: 'left' }}>Archived ({sections.archived.length})</Box>
                </Button>
                {archivedOpen && (
                  <List size="sm" sx={SESSION_LIST_SX}>
                    {sections.archived.map(session => (
                      <SessionRow key={session.id} session={session} {...rowProps} />
                    ))}
                  </List>
                )}
              </Box>
            )}
          </>
        )}
      </Box>

      {footer}
    </Stack>
  );
}

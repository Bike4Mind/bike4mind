import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { ChatSessionMode, ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { groupSessions, orderedSessions, quickSwitchIndices, type ProjectGroup } from './grouping';
import { ChevronIcon, MoreIcon, PanelLeftIcon, PlusIcon, SearchIcon, SlidersIcon } from './icons';
import { ModeSwitcher } from './ModeSwitcher';
import { SessionBadge } from './SessionBadge';

export const SIDEBAR_WIDTH = 280;

function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A primary nav entry: leading icon, label, and whatever trailing affordance it needs. */
function NavItem({
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
  indices: ReadonlyMap<string, number>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
}

function SessionRow({ session, activeId, statuses, indices, onSelect, onDelete, onTogglePin }: RowProps) {
  const status = statuses.get(session.id) ?? 'done';
  const needsAction = status === 'needs-action';

  return (
    <ListItem
      endAction={
        <Stack direction="row" spacing={0.25}>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={session.pinned ? `Unpin ${session.title}` : `Pin ${session.title}`}
            onClick={() => onTogglePin(session)}
            data-testid="chat-pin-session-btn"
          >
            <Typography level="body-xs">{session.pinned ? '*' : '+'}</Typography>
          </IconButton>
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            aria-label={`Delete ${session.title}`}
            onClick={() => onDelete(session.id)}
            data-testid="chat-delete-session-btn"
          >
            <Typography level="body-xs">x</Typography>
          </IconButton>
        </Stack>
      }
    >
      <ListItemButton
        selected={session.id === activeId}
        onClick={() => onSelect(session.id)}
        // An inset shadow rather than a border, so the row a user must answer is obvious while
        // scanning a long list without its text shifting 2px away from every other row.
        // Joy pins endAction to the right edge over the content, so the title needs room kept
        // for it or every long name runs underneath the pin and delete buttons.
        sx={{ pr: 7, ...(needsAction && { boxShadow: 'inset 2px 0 0 var(--joy-palette-warning-solidBg)' }) }}
        data-testid="chat-session-item"
        data-session-status={status}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
          <SessionBadge index={indices.get(session.id) ?? null} status={status} />
          <Stack sx={{ minWidth: 0 }}>
            <Typography level="body-sm" noWrap>
              {session.title}
            </Typography>
            <Typography level="body-xs" textColor="text.tertiary">
              {relativeDay(session.updatedAt)}
            </Typography>
          </Stack>
        </Stack>
      </ListItemButton>
    </ListItem>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1, pt: 1.5, pb: 0.5, fontWeight: 'lg' }}>
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
      sx={{ alignItems: 'center', gap: 0.25, px: 1, pt: 1.5, pb: 0.5 }}
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
 * Adapted from Claude Code desktop's layout. Two of its nav entries have no honest counterpart
 * here and are not shipped as dead links: "Artifacts" has nothing to point at, because desktop
 * conversations are local and produce none, and "Customize" is this app's tool settings, which
 * is what the Customize entry opens.
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
  onCreateInProject,
  onDelete,
  onTogglePin,
  customize,
  more,
  card,
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
  onCreateInProject: (directory: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  /** Which folders the agent may touch - Claude's "Customize", in this app's terms. */
  customize?: ReactNode;
  /** The collapsible More panel. */
  more?: ReactNode;
  /** The dismissible card slot above the account strip. */
  card?: ReactNode;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(session => session.title.toLowerCase().includes(needle));
  }, [sessions, query]);

  const sections = useMemo(() => groupSessions(matching, mode), [matching, mode]);
  const empty = sections.pinned.length === 0 && sections.projects.length === 0 && sections.loose.length === 0;

  const ordered = useMemo(() => orderedSessions(sections), [sections]);
  const indices = useMemo(() => quickSwitchIndices(ordered), [ordered]);

  // Read inside the key handler so the listener is bound once rather than rebuilt on every
  // keystroke in the search box, which re-orders this list.
  const target = useRef({ ordered, onSelect, onToggleCollapsed });
  target.current = { ordered, onSelect, onToggleCollapsed };

  /**
   * The numbers on the rows are a promise that they do something, so they do: the modifier
   * plus 1-9 opens the nth row, counted the way the sidebar draws them, and the same list the
   * search box is currently filtering. Bound on the window rather than the sidebar, because a
   * user reaching for it is almost always typing in the composer at the time.
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

  const rowProps = { activeId, statuses, indices, onSelect, onDelete, onTogglePin };

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
      <Stack direction="row" sx={{ alignItems: 'center', px: 1.5, pt: 1.5, pb: 0.5 }}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1, fontWeight: 'lg' }}>
          Bike4Mind
        </Typography>
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

      <Box sx={{ px: 1.5, pb: 1 }}>
        <ModeSwitcher mode={mode} onChange={onModeChange} />
      </Box>

      <Stack spacing={0.25} sx={{ px: 1, pb: 1 }}>
        <NavItem
          icon={<PlusIcon />}
          label={mode === 'code' ? 'New Code session' : 'New chat'}
          onClick={onCreate}
          testId="chat-new-session-btn"
        />
        <NavItem
          icon={<SlidersIcon />}
          label="Customize"
          onClick={() => setCustomizeOpen(open => !open)}
          end={<ChevronIcon open={customizeOpen} />}
          testId="sidebar-customize-btn"
        />
        {customizeOpen && <Box sx={{ px: 1, pb: 0.5 }}>{customize}</Box>}
        <NavItem
          icon={<MoreIcon />}
          label="More"
          onClick={() => setMoreOpen(open => !open)}
          end={<ChevronIcon open={moreOpen} />}
          testId="sidebar-more-btn"
        />
        {moreOpen && <Box sx={{ px: 1, pb: 0.5 }}>{more}</Box>}
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
                <List size="sm" sx={{ '--ListItem-radius': '6px', gap: 0.25 }}>
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
                <List size="sm" sx={{ '--ListItem-radius': '6px', gap: 0.25 }}>
                  {group.sessions.map(session => (
                    <SessionRow key={session.id} session={session} {...rowProps} />
                  ))}
                </List>
              </Box>
            ))}

            {sections.loose.length > 0 && (
              <Box>
                {sections.pinned.length > 0 && <SectionLabel>Conversations</SectionLabel>}
                <List size="sm" sx={{ '--ListItem-radius': '6px', gap: 0.25 }}>
                  {sections.loose.map(session => (
                    <SessionRow key={session.id} session={session} {...rowProps} />
                  ))}
                </List>
              </Box>
            )}
          </>
        )}
      </Box>

      {card}
      {footer}
    </Stack>
  );
}

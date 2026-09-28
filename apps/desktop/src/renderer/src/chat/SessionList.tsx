import { useMemo, useState, type ReactNode } from 'react';
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
import type { ChatSessionMode, ChatSessionSummary } from '@shared/chat';
import { groupSessions, type ProjectGroup } from './grouping';

function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Filled while a reply is streaming, hollow when idle. */
function StatusDot({ running }: { running: boolean }) {
  return (
    <Box
      aria-label={running ? 'Running' : 'Idle'}
      sx={{
        width: 7,
        height: 7,
        flexShrink: 0,
        borderRadius: '50%',
        border: '1px solid',
        borderColor: running ? 'primary.solidBg' : 'neutral.outlinedBorder',
        bgcolor: running ? 'primary.solidBg' : 'transparent',
      }}
      data-testid={running ? 'session-dot-running' : 'session-dot-idle'}
    />
  );
}

interface RowProps {
  session: ChatSessionSummary;
  activeId: string | null;
  runningIds: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
}

function SessionRow({ session, activeId, runningIds, onSelect, onDelete, onTogglePin }: RowProps) {
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
        data-testid="chat-session-item"
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
          <StatusDot running={runningIds.has(session.id)} />
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
  const actions: { label: string; glyph: string; run: () => void; testId: string }[] = [
    {
      label: `New session in ${group.name}`,
      glyph: '+',
      run: () => onCreateInProject(group),
      testId: 'project-new-btn',
    },
    { label: `Search ${group.name}`, glyph: 'o', run: () => onSearch(group), testId: 'project-search-btn' },
    { label: `${group.name} settings`, glyph: '...', run: () => onSettings(group), testId: 'project-settings-btn' },
  ];

  return (
    <Stack
      direction="row"
      sx={{ alignItems: 'center', gap: 0.5, px: 1, pt: 1.5, pb: 0.5 }}
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
          <Typography level="body-xs">{action.glyph}</Typography>
        </IconButton>
      ))}
    </Stack>
  );
}

/**
 * The sidebar: primary nav, a pinned section, then the sessions for the current mode - Code
 * sessions under a header per project, Chat sessions in one flat list.
 *
 * Adapted from Claude Code desktop's layout. Its "Artifacts" entry has no counterpart here
 * (desktop conversations are local and produce none), and "Customize" is the folder and model
 * settings this app already had, which is what More holds.
 */
export function SessionList({
  sessions,
  mode,
  loading,
  activeId,
  runningIds,
  onSelect,
  onCreate,
  onCreateInProject,
  onDelete,
  onTogglePin,
  more,
  footer,
}: {
  sessions: ChatSessionSummary[];
  mode: ChatSessionMode;
  loading: boolean;
  activeId: string | null;
  /** Sessions with a reply in flight, for the leading status dot. */
  runningIds: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onCreateInProject: (directory: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  /** The collapsible More panel: folder access and background processes. */
  more?: ReactNode;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(session => session.title.toLowerCase().includes(needle));
  }, [sessions, query]);

  const sections = useMemo(() => groupSessions(matching, mode), [matching, mode]);
  const empty = sections.pinned.length === 0 && sections.projects.length === 0 && sections.loose.length === 0;

  const rowProps = { activeId, runningIds, onSelect, onDelete, onTogglePin };

  return (
    <Stack
      sx={{
        width: 280,
        flexShrink: 0,
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
    >
      <Stack spacing={0.5} sx={{ p: 1.5, pb: 1 }}>
        <Button fullWidth size="sm" onClick={onCreate} data-testid="chat-new-session-btn">
          {mode === 'code' ? '+ New Code session' : '+ New chat'}
        </Button>
        <Input
          size="sm"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search conversations"
          slotProps={{ input: { 'data-testid': 'chat-search-input' } }}
        />
        <Button
          fullWidth
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setMoreOpen(open => !open)}
          sx={{ justifyContent: 'flex-start' }}
          data-testid="sidebar-more-btn"
        >
          {moreOpen ? 'v' : '>'} More
        </Button>
        {moreOpen && more}
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

      {footer}
    </Stack>
  );
}

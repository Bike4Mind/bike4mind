import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import IconButton from '@mui/joy/IconButton';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ReactNode } from 'react';
import type { ChatSessionSummary } from '@shared/chat';

function relativeDay(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return then.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function SessionList({
  sessions,
  loading,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  footer,
}: {
  sessions: ChatSessionSummary[];
  loading: boolean;
  activeId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onDelete: (sessionId: string) => void;
  footer?: ReactNode;
}) {
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
      <Box sx={{ p: 1.5 }}>
        <Button fullWidth size="sm" onClick={onCreate} data-testid="chat-new-session-btn">
          New chat
        </Button>
      </Box>

      <Box sx={{ overflowY: 'auto', flex: 1, px: 1, pb: 1 }}>
        {loading ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }}>
            Loading conversations...
          </Typography>
        ) : sessions.length === 0 ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }} data-testid="chat-sessions-empty">
            No conversations yet.
          </Typography>
        ) : (
          <List size="sm" sx={{ '--ListItem-radius': '6px', gap: 0.25 }}>
            {sessions.map(session => (
              <ListItem
                key={session.id}
                endAction={
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
                }
              >
                <ListItemButton
                  selected={session.id === activeId}
                  onClick={() => onSelect(session.id)}
                  data-testid="chat-session-item"
                >
                  <Stack sx={{ minWidth: 0 }}>
                    <Typography level="body-sm" noWrap>
                      {session.title}
                    </Typography>
                    <Typography level="body-xs" textColor="text.tertiary">
                      {relativeDay(session.updatedAt)}
                    </Typography>
                  </Stack>
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </Box>

      {footer}
    </Stack>
  );
}

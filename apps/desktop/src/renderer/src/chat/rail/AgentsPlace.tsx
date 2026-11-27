import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import List from '@mui/joy/List';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { AgentState } from '@shared/agentState';
import type { ChatSessionMode } from '@shared/chat';
import { RailAgentsIcon, RailChatIcon, RailCodeIcon, RailStudioIcon } from '../icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../layout';
import { stateJoyColor } from '../orchestrator/statePalette';
import { timeAgo } from '../prBarModel';
import type { BoardEntry, BoardGroup, BoardGroupKey } from './agentsBoard';

const MODE_ICON: Record<ChatSessionMode, () => ReactNode> = {
  chat: RailChatIcon,
  code: RailCodeIcon,
  studio: RailStudioIcon,
};

const MODE_LABEL: Record<ChatSessionMode, string> = { chat: 'Chat', code: 'Code', studio: 'Studio' };

/** Each group in its agent-state colour, so the board reads like the stage and the dock. */
const GROUP_STATE: Record<BoardGroupKey, AgentState> = {
  waiting: 'needs-you',
  failed: 'failed',
  finished: 'done',
};

interface AgentsPlaceProps {
  groups: readonly BoardGroup[];
  /** Opens the session in its own place: Chat, Code or Studio. */
  onOpen(sessionId: string): void;
  /** Every orchestration at a glance; the board lists only what waits on the user. */
  onOpenMissionControl?: () => void;
}

/** The Agents place: one board of every session waiting on the user, whatever place it lives in. */
export function AgentsPlace({ groups, onOpen, onOpenMissionControl }: AgentsPlaceProps) {
  const now = Date.now();
  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="agents-place">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ...contentColumnSx, py: 1.25 }}>
          <Typography level="title-md" sx={{ flex: 1, minWidth: 0 }}>
            Agents
          </Typography>
          {onOpenMissionControl && (
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={onOpenMissionControl}
              data-testid="agents-place-mission-control-btn"
            >
              Mission Control
            </Button>
          )}
        </Stack>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, py: 2 }}>
          {groups.length === 0 ? (
            <EmptyBoard />
          ) : (
            <Stack spacing={2.5}>
              {groups.map(group => (
                <BoardSection key={group.key} group={group} now={now} onOpen={onOpen} />
              ))}
            </Stack>
          )}
        </Box>
      </Box>
    </Stack>
  );
}

function EmptyBoard() {
  return (
    <Stack alignItems="center" spacing={1} sx={{ py: 8, textAlign: 'center' }} data-testid="agents-place-empty">
      <Box sx={{ color: 'text.tertiary', '& svg': { width: 28, height: 28 } }}>
        <RailAgentsIcon />
      </Box>
      <Typography level="title-sm">Nothing needs you</Typography>
      <Typography level="body-sm" textColor="text.tertiary" sx={{ maxWidth: 360 }}>
        Sessions waiting on an approval or an answer, failed turns and unread replies land here, from every place.
      </Typography>
    </Stack>
  );
}

function BoardSection({ group, now, onOpen }: { group: BoardGroup; now: number; onOpen(sessionId: string): void }) {
  const headingId = `agents-place-group-${group.key}`;
  return (
    <Box component="section" aria-labelledby={headingId} data-testid={`agents-place-group-${group.key}`}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.75 }}>
        <Typography id={headingId} level="title-sm" textColor="text.secondary">
          {group.label}
        </Typography>
        <Chip size="sm" variant="soft" color={stateJoyColor(GROUP_STATE[group.key])}>
          {group.entries.length}
        </Chip>
      </Stack>
      <List
        variant="outlined"
        sx={{ borderRadius: 'md', '--List-padding': '0px', '--ListItem-paddingY': '0px', overflow: 'hidden' }}
      >
        {group.entries.map((entry, index) => (
          <ListItem key={entry.id} sx={index > 0 ? { borderTop: '1px solid', borderColor: 'divider' } : undefined}>
            <BoardRow entry={entry} now={now} onOpen={onOpen} />
          </ListItem>
        ))}
      </List>
    </Box>
  );
}

function BoardRow({ entry, now, onOpen }: { entry: BoardEntry; now: number; onOpen(sessionId: string): void }) {
  const Icon = MODE_ICON[entry.mode];
  const when = timeAgo(entry.updatedAt, now);
  return (
    <ListItemButton
      onClick={() => onOpen(entry.id)}
      aria-label={`Open ${entry.title} in ${MODE_LABEL[entry.mode]}`}
      sx={{ alignItems: 'flex-start', gap: 1.25, py: 1.25, px: 1.5 }}
      data-testid={`agents-place-entry-${entry.id}`}
    >
      <Box sx={{ color: 'text.tertiary', pt: 0.25, flexShrink: 0, display: 'flex' }} title={MODE_LABEL[entry.mode]}>
        <Icon />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" alignItems="baseline" spacing={1}>
          <Typography level="title-sm" noWrap sx={{ flex: 1, minWidth: 0 }} title={entry.title}>
            {entry.title}
          </Typography>
          {when && (
            <Typography level="body-xs" textColor="text.tertiary" sx={{ flexShrink: 0 }}>
              {when}
            </Typography>
          )}
        </Stack>
        {entry.context && (
          <Typography level="body-xs" textColor="text.tertiary" noWrap title={entry.context}>
            {entry.context}
          </Typography>
        )}
        {entry.detail && (
          <Typography
            level="body-sm"
            textColor="text.secondary"
            sx={{
              mt: 0.25,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }}
            data-testid={`agents-place-entry-detail-${entry.id}`}
          >
            {entry.detail}
          </Typography>
        )}
      </Box>
    </ListItemButton>
  );
}

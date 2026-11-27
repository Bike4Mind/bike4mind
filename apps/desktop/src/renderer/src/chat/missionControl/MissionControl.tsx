import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import Chip from '@mui/joy/Chip';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import type { AgentState } from '@shared/agentState';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { CloseIcon, PanesIcon, SearchIcon } from '../icons';
import { columnStackSx, contentColumnSx, scrollingColumnHostSx } from '../layout';
import { timeAgo } from '../prBarModel';
import { stateJoyColor } from '../orchestrator/statePalette';
import { missionControlTiles, type MissionControlCounts, type MissionControlTile } from './missionControlModel';

/** Wider than the reading column: a grid of tiles, as the Artifacts library is. */
const COLUMN_MAX_WIDTH = 1120;

const COUNT_STATES: readonly { key: keyof Omit<MissionControlCounts, 'total'>; state: AgentState; label: string }[] = [
  { key: 'needsYou', state: 'needs-you', label: 'needs you' },
  { key: 'working', state: 'working', label: 'working' },
  { key: 'failed', state: 'failed', label: 'failed' },
  { key: 'done', state: 'done', label: 'done' },
];

interface MissionControlProps {
  sessions: readonly ChatSessionSummary[];
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  /** Presenter mode: titles become "Session N" and project names are hidden, as on the stage. */
  presenting: boolean;
  /** Opens a session on its Orchestrate stage. */
  onOpen(sessionId: string): void;
  /** Adds a session as a pinned pane beside the active orchestration. */
  onOpenBeside(sessionId: string): void;
  onClose(): void;
}

/**
 * Every orchestration at a glance: one tile per session running agents, what needs the user first. A tile
 * opens its session's stage; Open beside (or Shift/Cmd/Ctrl+click) adds it as a pane to the active one.
 */
export function MissionControl({ sessions, statuses, presenting, onOpen, onOpenBeside, onClose }: MissionControlProps) {
  const [query, setQuery] = useState('');
  const tiles = useMemo(
    () => missionControlTiles(sessions, statuses, { presenting, query }),
    [sessions, statuses, presenting, query]
  );
  const filtering = query.trim().length > 0;
  const now = Date.now();

  return (
    <Stack sx={{ flex: 1, minWidth: 0, ...columnStackSx }} data-testid="mission-control">
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ ...contentColumnSx, maxWidth: COLUMN_MAX_WIDTH, pt: 1.25, pb: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography level="title-md" sx={{ flex: 1 }}>
              Mission Control
            </Typography>
            <IconButton
              size="sm"
              variant="plain"
              color="neutral"
              aria-label="Close Mission Control"
              onClick={onClose}
              data-testid="mission-control-close-btn"
            >
              <CloseIcon />
            </IconButton>
          </Stack>
          <Typography level="body-sm" sx={{ mt: 0.5, opacity: 0.8 }}>
            Every session running agents. Open one, or Shift+click to add it beside the one you have open.
          </Typography>
          <Input
            size="sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Filter by title"
            startDecorator={<SearchIcon />}
            slotProps={{
              input: { 'data-testid': 'mission-control-filter-input', 'aria-label': 'Filter orchestrations' },
            }}
            sx={{ mt: 1.5 }}
          />
        </Box>
      </Box>
      <Box sx={{ flex: 1, ...scrollingColumnHostSx }}>
        <Box sx={{ ...contentColumnSx, maxWidth: COLUMN_MAX_WIDTH, py: 2 }}>
          {tiles.length === 0 ? (
            <Typography level="body-sm" sx={{ opacity: 0.7 }} data-testid="mission-control-empty">
              {filtering
                ? 'No orchestration matches that filter.'
                : 'Orchestrations appear here once a session starts agents.'}
            </Typography>
          ) : (
            <Box
              data-testid="mission-control-grid"
              sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 1.5 }}
            >
              {tiles.map(tile => (
                <MissionControlTileCard
                  key={tile.id}
                  tile={tile}
                  now={now}
                  onOpen={onOpen}
                  onOpenBeside={onOpenBeside}
                />
              ))}
            </Box>
          )}
        </Box>
      </Box>
    </Stack>
  );
}

const wantsBeside = (event: MouseEvent | KeyboardEvent) => event.shiftKey || event.metaKey || event.ctrlKey;

function MissionControlTileCard({
  tile,
  now,
  onOpen,
  onOpenBeside,
}: {
  tile: MissionControlTile;
  now: number;
  onOpen(sessionId: string): void;
  onOpenBeside(sessionId: string): void;
}) {
  const activate = (event: MouseEvent | KeyboardEvent) => (wantsBeside(event) ? onOpenBeside : onOpen)(tile.id);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    activate(event);
  };
  const lastActivity = timeAgo(tile.lastActivity, now);

  return (
    <Card
      variant="outlined"
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={onKeyDown}
      aria-label={`Open ${tile.title}`}
      data-testid={`mission-control-tile-${tile.id}`}
      data-needs-you={tile.needsYou ? 'true' : undefined}
      sx={theme => ({
        gap: 1,
        cursor: 'pointer',
        borderColor: tile.needsYou ? 'warning.outlinedBorder' : 'neutral.outlinedBorder',
        transition: 'border-color 120ms',
        '&:hover': { borderColor: tile.needsYou ? 'warning.outlinedColor' : 'neutral.outlinedHoverBorder' },
        [theme.focus.selector]: theme.focus.default,
      })}
    >
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="title-sm" noWrap title={tile.title}>
            {tile.title}
          </Typography>
          {tile.project && (
            <Typography level="body-xs" textColor="text.tertiary" noWrap title={tile.project}>
              {tile.project}
            </Typography>
          )}
        </Box>
        {tile.needsYou && (
          <Chip size="sm" variant="solid" color={stateJoyColor('needs-you')} data-testid="mission-control-needs-you">
            Needs you
          </Chip>
        )}
      </Stack>
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ minHeight: 24 }}>
        {tile.counts.total === 0 ? (
          <Typography level="body-xs" textColor="text.tertiary">
            No agents yet
          </Typography>
        ) : (
          COUNT_STATES.filter(({ key }) => tile.counts[key] > 0).map(({ key, state, label }) => (
            <Chip
              key={key}
              size="sm"
              variant="soft"
              color={stateJoyColor(state)}
              data-testid={`mission-control-count-${key}`}
            >
              {tile.counts[key]} {key === 'needsYou' && tile.counts[key] > 1 ? 'need you' : label}
            </Chip>
          ))
        )}
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ flex: 1 }}>
          {lastActivity ? `Active ${lastActivity}` : null}
        </Typography>
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          startDecorator={<PanesIcon />}
          onClick={event => {
            event.stopPropagation();
            onOpenBeside(tile.id);
          }}
          onKeyDown={event => event.stopPropagation()}
          data-testid={`mission-control-open-beside-btn-${tile.id}`}
        >
          Open beside
        </Button>
      </Stack>
    </Card>
  );
}

import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Typography from '@mui/joy/Typography';
import { useLayoutEffect, useRef } from 'react';
import { agentNowText } from './activity';
import { AgentStateChip } from './AgentStateChip';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { formatAgentCost, type AgentState, type AgentView } from './roster';

type ColumnId = 'needs-you' | 'working' | 'done' | 'failed';

const COLUMNS: ReadonlyArray<{ id: ColumnId; label: string; states: readonly AgentState[] }> = [
  { id: 'needs-you', label: 'Needs you', states: ['needs-you'] },
  { id: 'working', label: 'Working', states: ['working'] },
  { id: 'done', label: 'Done', states: ['done', 'stopped', 'idle'] },
  { id: 'failed', label: 'Failed', states: ['failed'] },
];

const FLIP_MS = 250;

const lineClamp = (lines: number) =>
  ({
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }) as const;

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Point {
  x: number;
  y: number;
}

/** Card position in board content space, so scrolling or resizing between commits is not read as a move. */
function positionIn(node: HTMLElement, board: HTMLElement): Point {
  const rect = node.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  const column = node.parentElement;
  return {
    x: rect.left - boardRect.left + board.scrollLeft + (column?.scrollLeft ?? 0),
    y: rect.top - boardRect.top + board.scrollTop + (column?.scrollTop ?? 0),
  };
}

/**
 * FLIP: after every commit, compare each card's board-relative position with the previous commit's
 * and slide moved cards from the old spot. Skips the first mount (nothing remembered) and reduced motion.
 */
function useFlip() {
  const boardRef = useRef<HTMLElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const previous = useRef(new Map<string, Point>());

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const animate = !prefersReducedMotion();
    const next = new Map<string, Point>();
    nodes.current.forEach(node => node.getAnimations?.().forEach(running => running.cancel()));
    nodes.current.forEach((node, id) => {
      const point = positionIn(node, board);
      next.set(id, point);
      const before = previous.current.get(id);
      if (!animate || !before || typeof node.animate !== 'function') return;
      const dx = before.x - point.x;
      const dy = before.y - point.y;
      if (dx === 0 && dy === 0) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: FLIP_MS,
        easing: 'ease',
      });
    });
    previous.current = next;
  });

  const refFor = (id: string) => {
    let callback = refCallbacks.current.get(id);
    if (!callback) {
      callback = (node: HTMLElement | null) => {
        if (node) nodes.current.set(id, node);
        else nodes.current.delete(id);
      };
      refCallbacks.current.set(id, callback);
    }
    return callback;
  };

  return { boardRef, refFor };
}

function BoardCard({
  agent,
  selected,
  onSelect,
  cardRef,
}: {
  agent: AgentView;
  selected: boolean;
  onSelect(id: string): void;
  cardRef(node: HTMLElement | null): void;
}) {
  const now = agentNowText(agent);
  const cost = formatAgentCost(agent.usdCost, agent.credits);
  return (
    <Box
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid={`orchestrator-board-card-${agent.id}`}
      title={agent.seedPrompt}
      onClick={() => onSelect(agent.id)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(agent.id);
      }}
      sx={{
        p: 1,
        borderRadius: 'sm',
        border: '1px solid',
        borderColor: selected ? 'primary.outlinedBorder' : 'divider',
        bgcolor: 'background.surface',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        '&:hover': { bgcolor: 'background.level1' },
      }}
    >
      <Typography level="title-sm" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {agent.title}
      </Typography>
      {now && (
        <Typography level="body-xs" sx={lineClamp(2)}>
          {now}
        </Typography>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        {(agent.state === 'stopped' || agent.state === 'idle') && <AgentStateChip state={agent.state} muted />}
        {cost && (
          <Typography level="body-xs" textColor="text.tertiary">
            {cost}
          </Typography>
        )}
        {agent.pr && <Chip size="sm" variant="outlined">{`#${agent.pr.number} ${agent.pr.state}`}</Chip>}
      </Box>
    </Box>
  );
}

export function BoardView({ agents, onSelect, selectedId }: OrchestratorViewProps) {
  const { boardRef, refFor } = useFlip();

  return (
    <Box
      ref={boardRef}
      data-testid="orchestrator-board"
      sx={{ display: 'flex', gap: 1.5, flex: 1, minHeight: 0, overflowX: 'auto', overflowY: 'hidden', p: 1.5 }}
    >
      {COLUMNS.map(column => {
        const cards = agents.filter(agent => column.states.includes(agent.state));
        return (
          <Box
            key={column.id}
            data-testid={`orchestrator-board-column-${column.id}`}
            sx={{ flex: '1 1 0', minWidth: 200, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography level="title-sm">{column.label}</Typography>
              <Typography
                level="body-sm"
                textColor="text.tertiary"
                sx={{ ml: 0.5 }}
                data-testid={`orchestrator-board-count-${column.id}`}
              >
                {cards.length}
              </Typography>
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
              {cards.length === 0 ? (
                <Typography level="body-xs" textColor="text.tertiary">
                  Nothing here
                </Typography>
              ) : (
                cards.map(agent => (
                  <BoardCard
                    key={agent.id}
                    agent={agent}
                    selected={agent.id === selectedId}
                    onSelect={onSelect}
                    cardRef={refFor(agent.id)}
                  />
                ))
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

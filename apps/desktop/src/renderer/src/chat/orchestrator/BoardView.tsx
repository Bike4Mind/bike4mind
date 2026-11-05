import Box from '@mui/joy/Box';
import Chip from '@mui/joy/Chip';
import Typography from '@mui/joy/Typography';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useElementWidth } from '../sessionPanelState';
import { agentNowText } from './activity';
import { AgentStateChip } from './AgentStateChip';
import { prefersReducedMotion } from './motion';
import type { OrchestratorViewProps } from './OrchestratorStage';
import { formatAgentCost, spawnerName, type AgentState, type AgentView } from './roster';

type ColumnId = 'needs-you' | 'working' | 'done' | 'failed';

const COLUMNS: ReadonlyArray<{ id: ColumnId; label: string; states: readonly AgentState[] }> = [
  { id: 'needs-you', label: 'Needs you', states: ['needs-you'] },
  { id: 'working', label: 'Working', states: ['working'] },
  { id: 'done', label: 'Done', states: ['done', 'stopped', 'idle'] },
  { id: 'failed', label: 'Failed', states: ['failed'] },
];

const FLIP_MS = 250;
// Columns with cards share their row's width and shrink to this before the board wraps them into
// another row; an empty column folds to its header, about EMPTY_COLUMN_WIDTH wide.
export const COLUMN_MIN_WIDTH = 150;
export const EMPTY_COLUMN_WIDTH = 96;
/** Between columns and between rows (px); the sx below uses the same value in spacing units. */
export const COLUMN_GAP = 10;

/**
 * Splits the columns, in order, into the fewest rows of near-equal count whose minimum widths fit
 * `available` (the board's content width). Balanced rather than greedy, so four columns that do not
 * fit become two and two rather than three and one. `null` is "not measured" and keeps one row.
 */
export function packBoardRows<T extends { empty: boolean }>(columns: readonly T[], available: number | null): T[][] {
  if (available === null || columns.length === 0) return [[...columns]];
  const widthOf = (row: readonly T[]) =>
    row.reduce((sum, column) => sum + (column.empty ? EMPTY_COLUMN_WIDTH : COLUMN_MIN_WIDTH), 0) +
    (row.length - 1) * COLUMN_GAP;
  for (let rowCount = 1; rowCount < columns.length; rowCount += 1) {
    const perRow = Math.ceil(columns.length / rowCount);
    const rows: T[][] = [];
    for (let start = 0; start < columns.length; start += perRow) rows.push(columns.slice(start, start + perRow));
    if (rows.every(row => widthOf(row) <= available)) return rows;
  }
  return columns.map(column => [column]);
}

const lineClamp = (lines: number) =>
  ({
    display: '-webkit-box',
    WebkitLineClamp: lines,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  }) as const;

interface Point {
  x: number;
  y: number;
}

/**
 * On-screen position relative to the board, deliberately without scroll offsets: a card that changes
 * column lands in a different scroll frame, and only the visual delta is what the eye should see slide.
 */
function visualPosition(node: HTMLElement, board: HTMLElement): Point {
  const rect = node.getBoundingClientRect();
  const boardRect = board.getBoundingClientRect();
  return { x: rect.left - boardRect.left, y: rect.top - boardRect.top };
}

/**
 * FLIP: after a commit that changes `layoutSignature` (column membership or order), compare each card's
 * visual position with the last snapshot and slide moved cards from the old spot. Other commits measure
 * nothing, so live activity updates stay cheap. The snapshot is also refreshed on scroll and resize so
 * neither alone reads as a move. Skips the first mount (nothing remembered) and reduced motion.
 */
function useFlip(layoutSignature: string) {
  const boardRef = useRef<HTMLElement | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const refCallbacks = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const previous = useRef(new Map<string, Point>());
  const running = useRef(new Map<string, Animation>());

  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    const animate = !prefersReducedMotion();
    const visual = new Map<string, Point>();
    nodes.current.forEach((node, id) => visual.set(id, visualPosition(node, board)));

    // Cancel only our own slides so hover and CSS transitions are untouched; a card caught mid-slide
    // restarts from where it is currently drawn rather than snapping.
    const inFlight = new Set<string>();
    running.current.forEach((animation, id) => {
      animation.cancel();
      inFlight.add(id);
    });
    running.current.clear();

    const next = new Map<string, Point>();
    nodes.current.forEach((node, id) => {
      const layout = visualPosition(node, board);
      next.set(id, layout);
      const origin = inFlight.has(id) ? visual.get(id) : previous.current.get(id);
      if (!animate || !origin || typeof node.animate !== 'function') return;
      const dx = origin.x - layout.x;
      const dy = origin.y - layout.y;
      if (dx === 0 && dy === 0) return;
      running.current.set(
        id,
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
          duration: FLIP_MS,
          easing: 'ease',
        })
      );
    });
    previous.current = next;
    refCallbacks.current.forEach((_callback, id) => {
      if (!nodes.current.has(id)) refCallbacks.current.delete(id);
    });
  }, [layoutSignature]);

  useEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    // Capture phase: column scrolls do not bubble.
    const resnapshot = () => {
      const next = new Map<string, Point>();
      nodes.current.forEach((node, id) => next.set(id, visualPosition(node, board)));
      previous.current = next;
    };
    board.addEventListener('scroll', resnapshot, { capture: true, passive: true });
    // A resize reflows every card. Guarded because jsdom has no ResizeObserver.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resnapshot);
    observer?.observe(board);
    return () => {
      board.removeEventListener('scroll', resnapshot, { capture: true });
      observer?.disconnect();
    };
  }, []);

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
  via,
  selected,
  onSelect,
  cardRef,
}: {
  agent: AgentView;
  /** The agent that spawned this one, below the first level. */
  via?: string;
  selected: boolean;
  onSelect(id: string): void;
  cardRef(node: HTMLElement | null): void;
}) {
  const now = agentNowText(agent);
  const costKnown = agent.usdCost !== undefined || agent.credits !== undefined;
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
      {via && (
        <Typography level="body-xs" textColor="text.tertiary" noWrap data-testid={`orchestrator-board-via-${agent.id}`}>
          via {via}
        </Typography>
      )}
      {now && (
        <Typography level="body-xs" sx={lineClamp(2)}>
          {now}
        </Typography>
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        {(agent.state === 'stopped' || agent.state === 'idle') && <AgentStateChip state={agent.state} muted />}
        {costKnown && (
          <Typography level="body-xs" textColor="text.tertiary">
            {formatAgentCost(agent.usdCost, agent.credits)}
          </Typography>
        )}
        {agent.pr && <Chip size="sm" variant="outlined">{`#${agent.pr.number} ${agent.pr.state}`}</Chip>}
      </Box>
    </Box>
  );
}

function columnCards(agents: readonly AgentView[], states: readonly AgentState[]): AgentView[] {
  return agents.filter(agent => states.includes(agent.state));
}

export function BoardView({ agents, onSelect, selectedId }: OrchestratorViewProps) {
  const [measureRef, boardWidth] = useElementWidth<HTMLDivElement>();
  const rows = packBoardRows(
    COLUMNS.map(column => {
      const cards = columnCards(agents, column.states);
      return { ...column, cards, empty: cards.length === 0 };
    }),
    boardWidth
  );
  // Row breaks are part of the layout: a card that moves rows on a resize is snapshotted afresh.
  const layoutSignature = rows
    .map(row => row.map(column => `${column.id}:${column.cards.map(agent => agent.id).join(',')}`).join('|'))
    .join('/');
  const { boardRef, refFor } = useFlip(layoutSignature);
  const setBoardRef = useCallback(
    (node: HTMLDivElement | null) => {
      boardRef.current = node;
      measureRef(node);
    },
    [boardRef, measureRef]
  );

  return (
    <Box
      ref={setBoardRef}
      data-testid="orchestrator-board"
      data-rows={rows.length}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: `${COLUMN_GAP}px`,
        flex: 1,
        minHeight: 0,
        overflowX: 'auto',
        overflowY: 'hidden',
        p: 1.5,
      }}
    >
      {rows.map(row => (
        <Box
          key={row.map(column => column.id).join('+')}
          data-testid="orchestrator-board-row"
          sx={{
            display: 'flex',
            gap: `${COLUMN_GAP}px`,
            // A row of empty columns is only headers, so the rows with cards take the height.
            flex: row.every(column => column.empty) ? '0 0 auto' : '1 1 0',
            minHeight: 0,
          }}
        >
          {row.map(({ id, label, cards, empty }) => (
            <Box
              key={id}
              data-testid={`orchestrator-board-column-${id}`}
              data-empty={empty || undefined}
              sx={{
                flex: empty ? '0 1 auto' : '1 1 0',
                minWidth: empty ? 0 : COLUMN_MIN_WIDTH,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                <Typography level="title-sm" textColor={empty ? 'text.tertiary' : undefined} noWrap>
                  {label}
                </Typography>
                <Typography
                  level="body-sm"
                  textColor="text.tertiary"
                  sx={{ ml: 0.5 }}
                  data-testid={`orchestrator-board-count-${id}`}
                >
                  {cards.length}
                </Typography>
              </Box>
              <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                {cards.map(agent => (
                  <BoardCard
                    key={agent.id}
                    agent={agent}
                    via={spawnerName(agent, agents)}
                    selected={agent.id === selectedId}
                    onSelect={onSelect}
                    cardRef={refFor(agent.id)}
                  />
                ))}
              </Box>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

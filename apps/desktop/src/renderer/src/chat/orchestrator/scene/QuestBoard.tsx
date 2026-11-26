import { useLayoutEffect, useRef, useState } from 'react';
import Box from '@mui/joy/Box';
import Dropdown from '@mui/joy/Dropdown';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import { keyframes } from '@mui/system';
import type { AgentView } from '../roster';
import { AgentPrIndicator } from '../AgentPrIndicator';
import { QUEST_DONE_LINGER_MS, questTitle, type QuestNote } from './quests';
import { noteCapacity, pinNotes } from './boardFit';
import type { SceneDefinition } from './sceneDefinition';
import { stateLampColor } from '../statePalette';

const NO_MOTION = '@media (prefers-reduced-motion: reduce)';
/** The last stretch (ms) of a finished note's linger, over which it fades before it is taken down. */
const TAKE_DOWN_MS = 1500;
const PARCHMENT = '#efdcb0';
const INK = '#2a1d10';
// A notched pixel outline, like the name plaques, rather than a rounded border.
const NOTE_EDGE = `0 -1px 0 #8a6a3c, 0 1px 0 #8a6a3c, -1px 0 0 #8a6a3c, 1px 0 0 #8a6a3c, 0 2px 0 rgba(0, 0, 0, 0.4)`;
const NOTE_FONT = 'clamp(7px, 1.5cqh, 10px)';
const SELECTED_GLOW = '0 0 0 2px #f5c542';

const fadeAway = keyframes`
  from { opacity: 0.6; }
  to { opacity: 0; }
`;

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

const fadeDelay = (finishedAt: number | undefined) =>
  QUEST_DONE_LINGER_MS - TAKE_DOWN_MS - (finishedAt === undefined ? 0 : Math.max(0, Date.now() - finishedAt));

const noteLabel = (name: string, note: QuestNote) =>
  `${name}: ${questTitle(note.agent)}${note.done ? ' (done)' : ''}; open agent`;

function Pin() {
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        top: '-0.35cqh',
        left: '50%',
        width: '0.9cqh',
        height: '0.9cqh',
        minWidth: 3,
        minHeight: 3,
        transform: 'translateX(-50%)',
        bgcolor: '#c0392b',
        boxShadow: '0 1px 0 #5e1a12',
      }}
    />
  );
}

/** A pinned note: who is on the quest and what it is; checked off and faded once it is done. */
function Note({
  testId,
  note,
  name,
  selected,
  onSelect,
  onOpenPr,
}: {
  testId: string;
  note: QuestNote;
  name: string;
  selected: boolean;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
}) {
  const { agent, done } = note;
  const title = questTitle(agent);
  return (
    <Box
      role="button"
      tabIndex={0}
      data-testid={`${testId}-${agent.id}`}
      data-done={done || undefined}
      aria-label={noteLabel(name, note)}
      aria-pressed={selected}
      title={`${name}: ${title}`}
      onClick={() => onSelect(agent.id)}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(agent.id);
      }}
      sx={{
        position: 'relative',
        flex: '0 0 auto',
        display: 'block',
        width: '100%',
        minWidth: 0,
        p: '0.5cqh 0.6cqh 0.4cqh',
        border: 0,
        borderRadius: 0,
        textAlign: 'left',
        bgcolor: PARCHMENT,
        color: INK,
        boxShadow: selected ? `${NOTE_EDGE}, ${SELECTED_GLOW}` : NOTE_EDGE,
        fontFamily: 'inherit',
        fontSize: NOTE_FONT,
        lineHeight: 1.2,
        cursor: 'pointer',
        transition: 'opacity 0.4s ease-out',
        ...(done && {
          opacity: 0.6,
          // Delay measured from finishedAt (negative once past), so a note that mounts late still fades on time.
          animation: `${fadeAway} ${TAKE_DOWN_MS}ms ease-in ${fadeDelay(note.finishedAt)}ms forwards`,
        }),
        [NO_MOTION]: { transition: 'none', animation: 'none' },
        '&:hover': { filter: 'brightness(1.06)' },
        '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 1 },
      }}
    >
      <Pin />
      <Box component="span" sx={{ ...ellipsis, display: 'flex', alignItems: 'center', gap: '0.5em', fontWeight: 700 }}>
        <Box
          component="span"
          aria-hidden
          data-quest-mark
          sx={{
            flex: '0 0 auto',
            width: '0.8em',
            textAlign: 'center',
            color: stateLampColor(done ? 'done' : agent.state),
          }}
        >
          {done ? '\u2713' : '\u25A0'}
        </Box>
        <Box component="span" sx={ellipsis}>
          {name}
        </Box>
      </Box>
      <Box component="span" sx={{ ...ellipsis, display: 'block', textDecoration: done ? 'line-through' : 'none' }}>
        {title}
      </Box>
      <AgentPrIndicator agentId={agent.id} pr={agent.pr} onOpen={() => onOpenPr?.(agent.id)} compact scene />
    </Box>
  );
}

/** The "+N" note: every quest the board has no room for, in a menu, so none is out of reach. */
function MoreNotes({
  testId,
  items,
  hidden,
  name,
  selectedId,
  onSelect,
  onOpenPr,
}: {
  testId: string;
  items: string;
  hidden: readonly QuestNote[];
  name(agent: AgentView): string;
  selectedId: string | null;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
}) {
  const holdsSelection = hidden.some(({ agent }) => agent.id === selectedId);
  return (
    <Dropdown>
      <MenuButton
        data-testid={`${testId}-more`}
        aria-label={`${hidden.length} more ${items}; list them`}
        variant="plain"
        sx={{
          position: 'relative',
          flex: '0 0 auto',
          minHeight: 0,
          p: '0.4cqh 0.6cqh',
          borderRadius: 0,
          bgcolor: PARCHMENT,
          color: INK,
          boxShadow: holdsSelection ? `${NOTE_EDGE}, ${SELECTED_GLOW}` : NOTE_EDGE,
          fontSize: NOTE_FONT,
          fontWeight: 700,
          lineHeight: 1.2,
          '&:hover, &:active, &[aria-expanded="true"]': { bgcolor: PARCHMENT, filter: 'brightness(1.06)' },
          '&:focus-visible': { outline: '2px solid #f5c542', outlineOffset: 1 },
        }}
      >
        <Pin />
        {`+${hidden.length}`}
      </MenuButton>
      <Menu
        size="sm"
        placement="bottom"
        data-testid={`${testId}-more-list`}
        sx={{ maxHeight: 280, overflowY: 'auto', minWidth: 220, zIndex: 'var(--joy-zIndex-popup)' }}
      >
        {hidden.map(note => (
          <MenuItem
            key={note.agent.id}
            data-testid={`${testId}-more-item-${note.agent.id}`}
            selected={note.agent.id === selectedId}
            onClick={() => onSelect(note.agent.id)}
            aria-label={noteLabel(name(note.agent), note)}
          >
            <ListItemDecorator>
              <Box
                aria-hidden
                sx={{
                  width: 8,
                  height: 8,
                  bgcolor: stateLampColor(note.done ? 'done' : note.agent.state),
                  boxShadow: `0 0 4px ${stateLampColor(note.done ? 'done' : note.agent.state)}`,
                }}
              />
            </ListItemDecorator>
            <Box sx={{ ...ellipsis, maxWidth: 280, textDecoration: note.done ? 'line-through' : 'none' }}>
              {`${name(note.agent)}: ${questTitle(note.agent)}`}
            </Box>
            <AgentPrIndicator
              agentId={note.agent.id}
              pr={note.agent.pr}
              onOpen={() => onOpenPr?.(note.agent.id)}
              compact
            />
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
}

/**
 * The quest board on the back wall: one note per open quest, each naming its agent and task. A
 * finished quest is checked off and taken down a little later (see useQuestNotes); clicking a note
 * selects its agent, which opens the peek drawer.
 */
export function QuestBoard({
  testId,
  board,
  plate,
  copy,
  notes,
  name,
  selectedId,
  onSelect,
  onOpenPr,
}: {
  /** Prefixes every test id: `<testId>-board`, `<testId>-<agent id>`, `<testId>-more`. */
  testId: string;
  board: SceneDefinition['map']['board'];
  plate: SceneDefinition['look']['plate'];
  copy: SceneDefinition['copy']['board'];
  notes: readonly QuestNote[];
  name(agent: AgentView): string;
  selectedId: string | null;
  onSelect(id: string): void;
  onOpenPr?(id: string): void;
}) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const board = boardRef.current;
    if (!board) return;
    setBoardHeight(board.clientHeight);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBoardHeight(board.clientHeight));
    observer.observe(board);
    return () => observer.disconnect();
  }, []);
  // Unmeasured (first paint, or no layout) falls back to the layout's nominal count.
  const capacity = boardHeight ? noteCapacity(boardHeight, notes.length, board) : board.notes;
  const { pinned, hidden } = pinNotes(notes, capacity);
  // A board too small for even the "+N" note is left undrawn rather than clipped; an empty one has
  // nothing to fit and keeps its "No quests posted" note.
  const tooSmall = notes.length > 0 && capacity === 0;
  const open = notes.filter(note => !note.done).length;
  return (
    <Box
      ref={boardRef}
      data-testid={`${testId}-board`}
      role="group"
      aria-label={`${copy.name}: ${open} open ${open === 1 ? copy.item : copy.items}`}
      style={{
        left: `${board.left}%`,
        top: `${board.top}%`,
        width: `${board.width}%`,
        height: `${board.height}%`,
      }}
      sx={{
        position: 'absolute',
        // Wall art: below every sprite, whose zIndex is its y.
        zIndex: 1,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.9cqh',
        p: '0.7cqh',
        pt: '0.4cqh',
        background: plate.background,
        boxShadow: plate.edge,
        overflow: 'hidden',
        ...(tooSmall && { visibility: 'hidden' }),
      }}
    >
      <Box
        aria-hidden
        sx={{
          flex: '0 0 auto',
          color: plate.ink,
          textShadow: '0 1px 0 #1f1208',
          fontSize: NOTE_FONT,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textAlign: 'center',
          textTransform: 'uppercase',
          lineHeight: 1.3,
        }}
      >
        {copy.title}
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: '0.9cqh',
          p: '0.6cqh 0.4cqh',
          // Cork behind the notes.
          bgcolor: '#9a7046',
          boxShadow: 'inset 0 1px 0 rgba(0, 0, 0, 0.35)',
          overflow: 'hidden',
        }}
      >
        {notes.length === 0 ? (
          <Box
            data-testid={`${testId}-empty`}
            sx={{ m: 'auto', color: 'rgba(42, 29, 16, 0.75)', fontSize: NOTE_FONT, fontStyle: 'italic' }}
          >
            {copy.empty}
          </Box>
        ) : (
          <>
            {pinned.map(note => (
              <Note
                key={note.agent.id}
                testId={testId}
                note={note}
                name={name(note.agent)}
                selected={note.agent.id === selectedId}
                onSelect={onSelect}
                onOpenPr={onOpenPr}
              />
            ))}
            {hidden.length > 0 && (
              <MoreNotes
                testId={testId}
                items={copy.items}
                hidden={hidden}
                name={name}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenPr={onOpenPr}
              />
            )}
          </>
        )}
      </Box>
    </Box>
  );
}

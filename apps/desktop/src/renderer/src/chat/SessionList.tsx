import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import List from '@mui/joy/List';
import ListDivider from '@mui/joy/ListDivider';
import ListItem from '@mui/joy/ListItem';
import ListItemButton from '@mui/joy/ListItemButton';
import ListItemContent from '@mui/joy/ListItemContent';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { Theme } from '@mui/joy/styles';
import { keyframes } from '@mui/system';
import {
  awaitsWorktree,
  normalizeSessionTitle,
  SESSION_TITLE_MAX_LENGTH,
  type ChatSessionMode,
  type ChatSessionStatus,
  type ChatSessionSummary,
  type OrchestratorLabel,
} from '@shared/chat';
import { useHasComposerDraft } from './composerDrafts';
import { useLocalHistory } from './localHistory';
import { refLabel } from '@shared/githubRefs';
import { findSessionsByRef } from './sessionRefSearch';
import { prAttentionRank } from '@shared/prAttention';
import type { PrSummary } from '@shared/pullRequest';
import { pendingDecisionOf } from '@shared/orchestration';
import { sectionOf, type SidebarSection, type SidebarSectionsState } from '@shared/sidebarSections';
import { capRows, raisedRows, setGroupLimit, useGroupLimit } from './groupCap';
import {
  descendantsOf,
  groupSessions,
  orderedSessions,
  parentHints,
  type CustomGroup,
  type ProjectGroup,
} from './grouping';
import { ImportedBadge } from './ImportedBadge';
import { SessionListFooter, type SessionListPaging } from './SessionListFooter';
import { withRows } from './sessionPages';
import { useSessionSearch, type SessionSearchFn } from './useSessionSearch';
import { useImportedInline } from './importedInline';
import { usePrAttentionSort } from './prAttentionSort';
import { keepMenuOpen } from './keepMenuOpen';
import { MessageSessionDialog } from './MessageSessionDialog';
import {
  AgentsIcon,
  ArrowLeftIcon,
  ArtifactIcon,
  CheckIcon,
  ChevronIcon,
  MissionControlIcon,
  MoreIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SubSessionsIcon,
} from './icons';
import { foldedParents, toggleFolded, useFoldedParents, useNestedSessions } from './nestedSessions';
import { orchestratorLabels, toggledOrchestratorLabel } from '@shared/orchestratorLabels';
import { matchSessionShortcut } from './rail/shortcuts';
import { ResizeHandle } from './ResizeHandle';
import { SectionNameDialog, type SectionNameRequest } from './SectionNameDialog';
import { thinScrollbarSx } from './layout';
import { SessionBadge } from './SessionBadge';
import { WORKING_COLOR_VAR } from './sessionStatus';
import { PREPARING_WORKTREE } from './chipState';
import { SESSION_DRAG_TYPE } from './sessionDrag';
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  writeSidebarWidth,
} from './sidebarWidth';
import type { SidebarSectionActions } from './useSidebarSections';

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
  loading,
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  end?: ReactNode;
  loading?: boolean;
  testId: string;
}) {
  return (
    <Button
      fullWidth
      size="sm"
      variant="plain"
      color="neutral"
      loading={loading}
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

/**
 * px each level of sub-session steps in. With the list's 8px inset and a 14px badge, a parent's
 * badge is centred 15px in, and its rail drops from there to the child's badge one step right.
 */
const NEST_INDENT = 14;
/** Levels that still step right; a deeper session stays at this indent and wears a "level N" chip. */
const MAX_NEST_DEPTH = 3;
const BADGE_CENTER = 15;
/** The gap SESSION_LIST_SX leaves between rows, which a rail has to bridge to stay unbroken. */
const ROW_GAP = 2;
/** A step past outlinedBorder, which all but vanished against the sidebar in the dark theme. */
const RAIL_COLOR = 'rgba(var(--joy-palette-neutral-mainChannel) / 0.4)';
/** Where an elbow stops, 2px short of the child's 14px badge (which starts 8px into the row). */
const ELBOW_END = 6;
/** From a first child's top edge up to 1px under its parent's badge: the gap plus half a row less half a badge, less 1. */
const FIRST_RAIL_REACH = ROW_GAP + 14 / 2 - 1;

/**
 * Where a row sits in a tree of spawned sessions, and what hangs under it. Spread onto the row as
 * primitives rather than passed as an object, so the memoized row still compares by value.
 */
interface NestProps {
  /** 0, or absent, for a row that is no one's child. */
  nestDepth?: number;
  /** First of its siblings, whose rail starts at the parent's badge rather than its own top. */
  nestFirst?: boolean;
  /** Last of its siblings, so its rail turns into it instead of running on past it. */
  nestLast?: boolean;
  /**
   * One character per ancestor level above the parent's: '1' where that ancestor still has
   * siblings below, so its rail runs straight through this row.
   */
  nestGuides?: string;
  /** The real spawn depth when it is past MAX_NEST_DEPTH, so the row can say how deep it sits. */
  nestDeeper?: number;
  /** Sessions anywhere under this one; 0 or absent on a row with none. */
  subCount?: number;
  /** The loudest state among them, which the fold pill wears while they are folded away. */
  subActivity?: SubActivity;
  subFolded?: boolean;
  /** False while a search holds every branch open, when folding could not show. */
  subFoldable?: boolean;
  /** Title of the parent a spawned session is drawn away from, shown as "from X". */
  hintTitle?: string;
}

type SubActivity = 'needs-action' | 'processing' | undefined;

/**
 * The rails into a nested row: straight lines for every ancestor level still running, and a
 * rounded elbow from the parent's badge into this one. Drawn on the ListItem's pseudo-elements
 * so they cost no DOM, and outside the button so its hover and selected fill start at the indent.
 */
function railSx(depth: number, first: boolean, last: boolean, guides: string, heat: SubActivity, elbow: boolean) {
  const indent = depth * NEST_INDENT;
  const straight = [...guides].flatMap((guide, level) => (guide === '1' ? [level] : []));
  if (!last && elbow) straight.push(depth - 1);
  const line = `linear-gradient(${RAIL_COLOR}, ${RAIL_COLOR})`;
  // The elbow into a branch holding working or waiting sessions lights up in the fold pill's colours,
  // so a deep tree shows where the activity is, even folded, and every ancestor on the path glows.
  const elbowColor =
    heat === 'needs-action' ? 'var(--joy-palette-warning-400)' : heat === 'processing' ? WORKING_COLOR_VAR : RAIL_COLOR;
  return {
    marginInlineStart: `${indent}px`,
    // Above the button, so a selected or hovered row's fill does not paint over its own elbow.
    '&::before': straight.length > 0 && {
      content: '""',
      position: 'absolute',
      zIndex: 1,
      pointerEvents: 'none',
      top: -ROW_GAP,
      bottom: 0,
      left: -indent,
      width: indent,
      backgroundImage: straight.map(() => line).join(', '),
      backgroundSize: '1px 100%',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: straight.map(level => `${level * NEST_INDENT + BADGE_CENTER}px 0`).join(', '),
    },
    // The first child reaches on up through the parent row to just under the parent's badge.
    '&::after': elbow && {
      content: '""',
      position: 'absolute',
      zIndex: 1,
      pointerEvents: 'none',
      top: -(first ? FIRST_RAIL_REACH : ROW_GAP),
      height: `calc(50% + ${first ? FIRST_RAIL_REACH : ROW_GAP}px)`,
      left: BADGE_CENTER - NEST_INDENT,
      width: NEST_INDENT - BADGE_CENTER + ELBOW_END,
      borderLeft: `1px solid ${elbowColor}`,
      borderBottom: `1px solid ${elbowColor}`,
      borderBottomLeftRadius: '7px',
      ...(heat === 'processing' && {
        animation: `${pulse} 1.2s ease-in-out infinite`,
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }),
    },
  };
}

const pulse = keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } });

/**
 * The fold control on a parent row: a branch glyph and how many sessions hang under it. Folded,
 * it fills in, and takes on the colour of anything underneath that is working or waiting on the
 * user, so folding a busy tree away never hides that it needs attention.
 *
 * A mouse shortcut only, hidden from assistive tech: it sits inside the row's own button, and the
 * row already carries aria-expanded and folds on Left/Right, so a second control would be nested.
 */
function FoldPill({
  sessionId,
  count,
  activity,
  folded,
  foldable,
}: {
  sessionId: string;
  count: number;
  activity: SubActivity;
  folded: boolean;
  foldable: boolean;
}) {
  const color = activity === 'needs-action' ? 'warning' : activity === 'processing' ? 'primary' : 'neutral';
  const label = `${folded ? 'Show' : 'Hide'} ${count} sub-session${count === 1 ? '' : 's'}`;
  const toggle = (event: SyntheticEvent) => {
    event.stopPropagation();
    toggleFolded(sessionId);
  };
  return (
    <Box
      component="span"
      aria-hidden
      title={foldable ? label : undefined}
      onClick={foldable ? toggle : undefined}
      onDoubleClick={isolate}
      sx={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
        height: 18,
        px: '5px',
        borderRadius: '9px',
        fontSize: '0.6875rem',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1,
        cursor: foldable ? 'pointer' : 'default',
        transition: 'background-color 120ms, color 120ms',
        color: folded && activity ? `${color}.plainColor` : 'text.tertiary',
        bgcolor: folded ? `${color}.softBg` : 'transparent',
        '& svg': { transition: 'transform 160ms', transform: folded ? 'none' : 'rotate(90deg) scaleY(-1)' },
        '&:hover': foldable ? { bgcolor: `${color}.softHoverBg`, color: `${color}.softColor` } : undefined,
      }}
      data-testid="chat-session-fold-btn"
      data-folded={folded ? 'true' : 'false'}
      data-activity={activity}
    >
      <SubSessionsIcon size={12} />
      {count}
      {folded && activity && (
        <Box
          component="span"
          sx={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            bgcolor: `${color}.solidBg`,
            animation: activity === 'processing' ? `${pulse} 1.2s ease-in-out infinite` : 'none',
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
          }}
        />
      )}
    </Box>
  );
}

/**
 * Marks an orchestrator's row with the composer's Orchestrate icon, so it reads apart from a session
 * that only nests plain sub-sessions. Named for assistive tech, since the badge beside it names only the status.
 */
function OrchestratorGlyph() {
  return (
    <Box
      component="span"
      role="img"
      aria-label="Orchestrator"
      title="Orchestrator"
      data-testid="chat-session-orchestrator-glyph"
      sx={{ display: 'grid', color: 'primary.plainColor', '& svg': { width: 13, height: 13 } }}
    >
      <AgentsIcon />
    </Box>
  );
}

/** One object for the whole list, stable across renders, so a memoized row only redraws when its own data does. */
interface RowActions {
  select: (sessionId: string) => void;
  remove: (sessionId: string) => void;
  togglePin: (session: ChatSessionSummary) => void;
  toggleArchived: (session: ChatSessionSummary) => void;
  setOrchestratorLabel: (session: ChatSessionSummary, label: OrchestratorLabel) => void;
  rename: (session: ChatSessionSummary, title: string) => void;
  download: (session: ChatSessionSummary) => void;
  /** Opens the dialog that sends a message into this session without opening it. */
  message: (session: ChatSessionSummary) => void;
  /** Null takes the session out of its section. */
  moveToSection: (sessionId: string, sectionId: string | null) => void;
  /** Opens the name dialog for a section the session will be moved into. */
  requestNewSection: (sessionId: string) => void;
  /** A row was picked up to drag into, or out of, a section; null when the drag ends. */
  drag: (sessionId: string | null) => void;
}

interface RowProps extends NestProps {
  session: ChatSessionSummary;
  selected: boolean;
  status: ChatSessionStatus;
  pr: PrSummary | undefined;
  /** Every user section, for the Move to menu. The state's own array, so it is stable between changes. */
  userSections: readonly SidebarSection[];
  sectionId: string | undefined;
  actions: RowActions;
  /** Set on a search result found by issue or PR number: what it matched, e.g. `PR #1234`. */
  refChip?: string;
  /** Marks the session as an orchestrator (orchestratorLabels), apart from one that only nests sub-sessions. */
  orchestrator?: boolean;
  /** What the automatic rule alone says, so the menu clears an override rather than setting a redundant one. */
  orchestratorAutomatic?: boolean;
}

/** The right-aligned letter that runs a row menu item while the menu is open; see onRowMenuKeyDown. */
function MenuShortcut({ letter }: { letter: string }) {
  return (
    <Typography aria-hidden level="body-xs" textColor="text.tertiary" sx={{ ml: 3, fontFamily: 'monospace' }}>
      {letter}
    </Typography>
  );
}

/**
 * A bare letter runs the item whose data-shortcut it is, by clicking it so the item's own handler
 * decides what happens (closing, switching view). Marked handled so Joy's type-to-focus stays out.
 */
function onRowMenuKeyDown(event: ReactKeyboardEvent<HTMLElement> & { defaultMuiPrevented?: boolean }) {
  if (event.metaKey || event.ctrlKey || event.altKey || !/^[a-z]$/i.test(event.key)) return;
  const item = event.currentTarget.querySelector<HTMLElement>(`[data-shortcut="${event.key.toUpperCase()}"]`);
  if (!item || item.getAttribute('aria-disabled') === 'true') return;
  event.preventDefault();
  event.defaultMuiPrevented = true;
  item.click();
}

/** Shown in place of the main menu items, not as a flyout: Joy has no nested menu. */
function MoveToItems({
  session,
  userSections,
  sectionId,
  actions,
  onBack,
}: {
  session: ChatSessionSummary;
  userSections: readonly SidebarSection[];
  sectionId: string | undefined;
  actions: RowActions;
  onBack: (event: SyntheticEvent) => void;
}) {
  const current = userSections.find(section => section.id === sectionId);
  return (
    <>
      <MenuItem onClick={onBack} data-testid="chat-move-back-btn">
        <ListItemDecorator>
          <ArrowLeftIcon />
        </ListItemDecorator>
        Move to section
      </MenuItem>
      <ListDivider />
      {userSections.map(section => (
        <MenuItem
          key={section.id}
          selected={section.id === sectionId}
          onClick={() => actions.moveToSection(session.id, section.id)}
          data-testid="chat-move-to-section-btn"
          data-section-id={section.id}
        >
          <ListItemDecorator>{section.id === sectionId && <CheckIcon />}</ListItemDecorator>
          {section.name}
        </MenuItem>
      ))}
      {current && (
        <MenuItem onClick={() => actions.moveToSection(session.id, null)} data-testid="chat-move-remove-btn">
          <ListItemDecorator />
          Remove from {current.name}
        </MenuItem>
      )}
      {userSections.length > 0 && <ListDivider />}
      <MenuItem onClick={() => actions.requestNewSection(session.id)} data-testid="chat-move-new-section-btn">
        <ListItemDecorator>
          <PlusIcon />
        </ListItemDecorator>
        New section
      </MenuItem>
    </>
  );
}

/**
 * Whether the title is wider than the box drawing it. Watched rather than measured once:
 * the row takes 2rem away from the title when its menu button appears and hands it back
 * when it goes, so the answer changes without the text changing.
 */
function useTitleClipped(title: string, editing: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [clipped, setClipped] = useState(false);

  // `editing` is a dependency because the title node is replaced by the input and comes back
  // as a new node, which the old observer is not watching.
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
  }, [title, editing]);

  return { ref, clipped };
}

/** Swallowed so the row underneath neither opens the session nor sees the keys as its own. */
const isolate = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The title as an input, for renaming in place. Enter and blur save, Escape cancels; an empty,
 * blank or unchanged name saves nothing.
 *
 * Keydown stops here, which is also what keeps SessionList's window-level Cmd shortcuts away
 * while typing: React's handler runs at the root, before the event reaches window.
 *
 * Focus and blur stop here too: the input sits inside the row's ListItemButton, which would take
 * the input's focus as its own keyboard focus and keep its focus ring once the input unmounts,
 * since an unmounted node sends no blur.
 */
function RenameInput({ title, onDone }: { title: string; onDone: (next: string | null) => void }) {
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Enter unmounts the input, and some engines blur a focused node as it goes; one answer only.
  const finish = (next: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(next);
  };
  const save = () => {
    const next = normalizeSessionTitle(draft);
    finish(next && next !== title ? next : null);
  };

  return (
    <Input
      size="sm"
      value={draft}
      onChange={event => setDraft(event.target.value)}
      onFocus={isolate}
      onBlur={event => {
        event.stopPropagation();
        save();
      }}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') save();
        if (event.key === 'Escape') finish(null);
      }}
      onClick={isolate}
      onDoubleClick={isolate}
      onMouseDown={isolate}
      slotProps={{
        input: {
          ref: input,
          maxLength: SESSION_TITLE_MAX_LENGTH,
          'aria-label': 'Rename session',
          'data-testid': 'chat-session-rename-input',
        },
      }}
      sx={{
        flex: 1,
        minWidth: 0,
        // Shorter than Joy's sm floor so the row keeps its 28px height while editing.
        '--Input-minHeight': '22px',
        '--Input-paddingInline': '4px',
        '--Input-radius': '4px',
        fontSize: '0.8125rem',
      }}
    />
  );
}

const SessionRow = memo(function SessionRow({
  session,
  selected,
  status,
  pr,
  userSections,
  sectionId,
  actions,
  nestDepth = 0,
  nestFirst = false,
  nestLast = false,
  nestGuides = '',
  nestDeeper = 0,
  subCount = 0,
  subActivity,
  subFolded = false,
  subFoldable = true,
  hintTitle,
  refChip,
  orchestrator = false,
  orchestratorAutomatic = false,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'move'>('main');
  const [editing, setEditing] = useState(false);
  const nestHeat: SubActivity =
    status === 'needs-action' || subActivity === 'needs-action'
      ? 'needs-action'
      : status === 'processing' || subActivity === 'processing'
        ? 'processing'
        : undefined;
  // Main pushes the project once the worktree exists, which is what ends this.
  const preparing = status === 'processing' && awaitsWorktree(session.project);
  const { ref: titleRef, clipped } = useTitleClipped(session.title, editing);
  // The open conversation's draft is in the composer in front of the user; only others are marked.
  const showDraft = useHasComposerDraft(session.id) && !selected && !editing;

  const onRenameDone = (next: string | null) => {
    setEditing(false);
    if (next) actions.rename(session, next);
  };

  return (
    <ListItem
      data-nest-depth={nestDepth || undefined}
      data-nest-guides={nestGuides || undefined}
      data-nest-heat={nestDepth > 0 ? nestHeat : undefined}
      sx={{
        ...(nestDepth > 0 && railSx(nestDepth, nestFirst, nestLast, nestGuides, nestHeat, nestDeeper === 0)),
        ...(editing
          ? { '--ListItem-endActionWidth': '0px' }
          : {
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
            }),
      }}
      endAction={
        // Gone while editing, not just hidden: closing the menu hands focus back to its button,
        // which would blur - and so save - the input the Rename item just opened.
        editing ? undefined : (
          <Box sx={{ opacity: 'var(--row-actions-opacity)', transition: 'opacity 120ms' }}>
            <Dropdown
              open={menuOpen}
              onOpenChange={(_event, open) => {
                setMenuOpen(open);
                // Every opening starts on the main items, wherever the last one was left.
                if (!open) setMenuView('main');
              }}
            >
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
              <Menu size="sm" placement="bottom-end" onKeyDown={onRowMenuKeyDown} sx={{ minWidth: 200 }}>
                {menuView === 'move' ? (
                  <MoveToItems
                    session={session}
                    userSections={userSections}
                    sectionId={sectionId}
                    actions={actions}
                    onBack={event => {
                      keepMenuOpen(event);
                      setMenuView('main');
                    }}
                  />
                ) : (
                  <>
                    <MenuItem
                      onClick={() => actions.togglePin(session)}
                      data-testid="chat-pin-session-btn"
                      data-shortcut="P"
                      aria-keyshortcuts="P"
                    >
                      <Box sx={{ flex: 1 }}>{session.pinned ? 'Unpin' : 'Pin'}</Box>
                      <MenuShortcut letter="P" />
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        // Shut by hand: the Dropdown unmounts before it can report closing, and would
                        // otherwise come back open when editing ends.
                        setMenuOpen(false);
                        setEditing(true);
                      }}
                      data-testid="chat-rename-session-btn"
                      data-shortcut="R"
                      aria-keyshortcuts="R"
                    >
                      <Box sx={{ flex: 1 }}>Rename</Box>
                      <MenuShortcut letter="R" />
                    </MenuItem>
                    <MenuItem
                      disabled={!!session.archived}
                      onClick={() => actions.message(session)}
                      data-testid="session-row-message-action"
                      data-shortcut="M"
                      aria-keyshortcuts="M"
                    >
                      <Box sx={{ flex: 1 }}>Message session...</Box>
                      <MenuShortcut letter="M" />
                    </MenuItem>
                    <MenuItem
                      onClick={() => actions.download(session)}
                      data-testid="chat-download-session-btn"
                      data-shortcut="L"
                      aria-keyshortcuts="L"
                    >
                      <Box sx={{ flex: 1 }}>Download</Box>
                      <MenuShortcut letter="L" />
                    </MenuItem>
                    <MenuItem
                      onClick={() =>
                        actions.setOrchestratorLabel(
                          session,
                          toggledOrchestratorLabel(orchestrator, orchestratorAutomatic)
                        )
                      }
                      data-testid="chat-session-orchestrator-label-btn"
                      data-shortcut="O"
                      aria-keyshortcuts="O"
                    >
                      <Box sx={{ flex: 1 }}>{orchestrator ? "Don't show as orchestrator" : 'Show as orchestrator'}</Box>
                      <MenuShortcut letter="O" />
                    </MenuItem>
                    {!session.pinned && !session.archived && (
                      <>
                        <ListDivider />
                        <MenuItem
                          onClick={event => {
                            keepMenuOpen(event);
                            setMenuView('move');
                          }}
                          data-testid="chat-move-session-btn"
                        >
                          <Box sx={{ flex: 1 }}>Move to section</Box>
                          <ChevronIcon open={false} />
                        </MenuItem>
                      </>
                    )}
                    <ListDivider />
                    <MenuItem
                      onClick={() => actions.toggleArchived(session)}
                      data-testid="chat-archive-session-btn"
                      data-shortcut="A"
                      aria-keyshortcuts="A"
                    >
                      <Box sx={{ flex: 1 }}>{session.archived ? 'Unarchive' : 'Archive'}</Box>
                      <MenuShortcut letter="A" />
                    </MenuItem>
                    <MenuItem
                      color="danger"
                      onClick={() => actions.remove(session.id)}
                      data-testid="chat-delete-session-btn"
                      data-shortcut="D"
                      aria-keyshortcuts="D"
                    >
                      <Box sx={{ flex: 1 }}>Delete</Box>
                      <MenuShortcut letter="D" />
                    </MenuItem>
                  </>
                )}
              </Menu>
            </Dropdown>
          </Box>
        )
      }
    >
      <ListItemButton
        selected={selected}
        aria-current={selected ? 'true' : undefined}
        onClick={editing ? undefined : () => actions.select(session.id)}
        aria-expanded={subCount > 0 ? !subFolded : undefined}
        onKeyDown={event => {
          // A tree's own keys: right opens a folded parent, left folds an open one.
          if (subCount === 0 || !subFoldable || editing) return;
          if (event.key === (subFolded ? 'ArrowRight' : 'ArrowLeft')) {
            event.preventDefault();
            toggleFolded(session.id);
          }
        }}
        // Not while renaming, or selecting text in the input would pick the whole row up.
        draggable={!editing}
        onDragStart={event => {
          // Pinned and archived rows are drawn outside the sections, so a filed one would vanish.
          if (session.pinned || session.archived) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
          actions.drag(session.id);
        }}
        onDragEnd={() => actions.drag(null)}
        sx={{
          // Paired with the opacity the button fades in on, so the title's edge travels with
          // the button instead of snapping the moment the pointer lands.
          transition: 'padding-inline-end 120ms',
        }}
        data-testid="chat-session-item"
        data-session-status={status}
        data-session-pr-state={pr?.state}
      >
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
          {/* One Stack child, so the glyph sits closer to the badge than the Stack's spacing would put it. */}
          <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
            <SessionBadge
              status={status}
              pr={pr}
              outcome={session.lastOutcome}
              deciding={pendingDecisionOf(session.workerTask) !== undefined}
            />
            {orchestrator && <OrchestratorGlyph />}
          </Box>
          {editing ? (
            <RenameInput title={session.title} onDone={onRenameDone} />
          ) : (
            /* Between Joy's body-sm and body-xs: at body-xs the row matches its own group header,
               which is bold, so the header outweighs the content it labels. The weight is spelled
               out because Joy's body-xs level carries fontWeight md, which drew every title
               heavier than the rest of the sidebar - a title is content, not a heading. */
            <Typography
              ref={titleRef}
              level="body-xs"
              noWrap
              onDoubleClick={() => setEditing(true)}
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
              data-testid="chat-session-title-text"
            >
              {session.title}
            </Typography>
          )}
          {showDraft && (
            <Typography
              level="body-xs"
              noWrap
              textColor="text.tertiary"
              sx={{ flexShrink: 0, fontSize: '0.6875rem', fontStyle: 'italic' }}
              title="Unsent text in the composer"
              data-testid="chat-session-draft-marker"
            >
              Draft
            </Typography>
          )}
          {!editing && hintTitle && (
            <Typography
              level="body-xs"
              noWrap
              textColor="text.tertiary"
              sx={{ flexShrink: 1000, minWidth: 0, fontSize: '0.75rem', fontWeight: 'normal' }}
              title={`from ${hintTitle}`}
              data-testid="chat-session-parent-hint"
            >
              from {hintTitle}
            </Typography>
          )}
          {!editing && nestDeeper > 0 && (
            <Typography
              level="body-xs"
              noWrap
              textColor="text.tertiary"
              sx={{ flexShrink: 0, fontSize: '0.6875rem' }}
              title={`level ${nestDeeper + 1} of the tree`}
              data-testid="chat-session-depth-chip"
            >
              level {nestDeeper + 1}
            </Typography>
          )}
          {!editing && session.importOrigin && <ImportedBadge origin={session.importOrigin} />}
          {refChip && !editing && (
            <Box sx={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
              <Chip size="sm" variant="soft" color="primary" sx={{ flexShrink: 0 }} data-testid="chat-session-ref-chip">
                {refChip}
              </Chip>
            </Box>
          )}
          {preparing && !editing && (
            <Typography
              level="body-xs"
              noWrap
              textColor="text.tertiary"
              sx={{ flexShrink: 0, fontSize: '0.75rem' }}
              data-testid="chat-session-preparing"
            >
              {PREPARING_WORKTREE}
            </Typography>
          )}
          {subCount > 0 && !editing && (
            // A spacer rather than margin-left: auto, which the Stack's own spacing overrides.
            <Box sx={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
              <FoldPill
                sessionId={session.id}
                count={subCount}
                activity={subActivity}
                folded={subFolded}
                foldable={subFoldable}
              />
            </Box>
          )}
        </Stack>
      </ListItemButton>
    </ListItem>
  );
});

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
}: {
  group: ProjectGroup;
  onCreateInProject: (group: ProjectGroup) => void;
}) {
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
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={`New session in ${group.name}`}
        onClick={() => onCreateInProject(group)}
        data-testid="project-new-btn"
      >
        <PlusIcon />
      </IconButton>
    </Stack>
  );
}

/**
 * A user section's header: its name, then a "+" for a new session in it and a menu to start one,
 * rename or delete it, both showing on hover like a row's. Double-clicking the name renames it, as
 * it does a session row's title.
 */
function CustomSectionHeader({
  section,
  onCreateSession,
  onRename,
  onDelete,
}: {
  section: SidebarSection;
  onCreateSession: (section: SidebarSection) => void;
  onRename: (section: SidebarSection) => void;
  onDelete: (section: SidebarSection) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <Stack
      direction="row"
      sx={{
        alignItems: 'center',
        gap: 0.25,
        ...GROUP_HEADER_SX,
        '--section-actions-opacity': menuOpen ? 1 : 0,
        '&:hover, &:focus-within': { '--section-actions-opacity': 1 },
      }}
      data-testid="sidebar-section-header"
    >
      <Typography
        level="body-xs"
        noWrap
        sx={{ flex: 1, minWidth: 0, fontWeight: 'lg' }}
        onDoubleClick={() => onRename(section)}
        data-testid="sidebar-section-name"
      >
        {section.name}
      </Typography>
      <Stack
        direction="row"
        sx={{ alignItems: 'center', opacity: 'var(--section-actions-opacity)', transition: 'opacity 120ms' }}
      >
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`New session in section ${section.name}`}
          onClick={() => onCreateSession(section)}
          data-testid="sidebar-section-new-btn"
        >
          <PlusIcon />
        </IconButton>
        <Dropdown open={menuOpen} onOpenChange={(_event, open) => setMenuOpen(open)}>
          <MenuButton
            slots={{ root: IconButton }}
            slotProps={{
              root: {
                size: 'sm',
                variant: 'plain',
                color: 'neutral',
                'aria-label': `Options for section ${section.name}`,
                'data-testid': 'sidebar-section-menu-btn',
              },
            }}
          >
            <MoreIcon />
          </MenuButton>
          <Menu size="sm" placement="bottom-end">
            <MenuItem onClick={() => onCreateSession(section)} data-testid="sidebar-section-new-session-btn">
              New session
            </MenuItem>
            <MenuItem onClick={() => onRename(section)} data-testid="sidebar-section-rename-btn">
              Rename
            </MenuItem>
            {/* Only the section goes: its sessions fall back to where they were before. */}
            <MenuItem color="danger" onClick={() => onDelete(section)} data-testid="sidebar-section-delete-btn">
              Delete section
            </MenuItem>
          </Menu>
        </Dropdown>
      </Stack>
    </Stack>
  );
}

const SHOW_MORE_SX = {
  justifyContent: 'flex-start',
  minHeight: '28px',
  px: 1,
  '--Button-radius': '6px',
  fontSize: '0.8125rem',
  fontWeight: 'normal',
  // A step past text.tertiary, which is what the row titles already draw in.
  color: (theme: Theme) => theme.vars.palette.neutral[theme.palette.mode === 'dark' ? 500 : 400],
};

/** Statuses a row is never hidden behind "Show more" in: the user is waiting on it or it on them. */
const isLive = (status: ChatSessionStatus | undefined) => status === 'processing' || status === 'needs-action';

/** The loudest live status among `sessions`: the user waiting on one outranks one working. */
function loudestActivity(
  sessions: readonly ChatSessionSummary[],
  statuses: ReadonlyMap<string, ChatSessionStatus>
): SubActivity {
  let loudest: SubActivity;
  for (const session of sessions) {
    const status = statuses.get(session.id);
    if (status === 'needs-action') return status;
    if (status === 'processing') loudest = status;
  }
  return loudest;
}

/**
 * A group's rows, capped at GROUP_ROW_CAP with "Show more" below them. The active, live and
 * just-moved rows draw in place whatever the cap, and a row that has drawn past the cap keeps
 * drawing for the rest of the run. `uncapped` is set while a search is narrowing the list, which
 * then shows every match.
 */
function CappedSessionRows({
  groupKey,
  testIdPrefix,
  sessions,
  uncapped,
  activeId,
  statuses,
  revealId,
  row,
  descendants,
}: {
  groupKey: string;
  testIdPrefix: 'sidebar-project' | 'sidebar-section';
  sessions: ChatSessionSummary[];
  uncapped: boolean;
  activeId: string | null;
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  /** A session just moved into this group, whose updatedAt slot may sit behind the cap. */
  revealId: string | null;
  row: (session: ChatSessionSummary) => ReactNode;
  /** What hangs under a row, which keeps the row in view whenever one of those would be kept. */
  descendants: (session: ChatSessionSummary) => readonly ChatSessionSummary[];
}) {
  const limit = useGroupLimit(groupKey);
  const capped = useMemo(() => {
    if (uncapped) return null;
    // Append-only and idempotent, so a repeat render (React may discard and re-run one) is harmless.
    const raised = raisedRows(groupKey);
    const kept = (session: ChatSessionSummary) =>
      session.id === activeId || isLive(statuses.get(session.id)) || session.id === revealId;
    const rows = capRows(
      sessions,
      limit,
      session => raised.has(session.id) || kept(session) || descendants(session).some(kept)
    );
    for (const session of rows.visible.slice(limit)) raised.add(session.id);
    return rows;
  }, [groupKey, sessions, uncapped, limit, activeId, revealId, statuses, descendants]);

  return (
    <>
      <List size="sm" sx={SESSION_LIST_SX}>
        {(capped?.visible ?? sessions).flatMap(row)}
      </List>
      {capped && capped.hidden > 0 && (
        <Button
          fullWidth
          size="sm"
          variant="plain"
          color="neutral"
          onClick={() => setGroupLimit(groupKey, capped.nextLimit)}
          sx={SHOW_MORE_SX}
          data-testid={`${testIdPrefix}-show-more-btn`}
        >
          Show more
        </Button>
      )}
    </>
  );
}

/** Where a dragged row would land: a section by id, or the default groups, out of any section. */
type DropTarget = { kind: 'section'; sectionId: string } | { kind: 'default' };

/** Rows a right-click in them should leave alone; the sidebar's own menu is for empty space. */
const OWN_CONTEXT_TARGETS = '[data-testid="chat-session-item"], input, textarea, [role="menu"]';

/**
 * The sidebar of the Chat and Code places: primary nav, a pinned section, then the sessions for
 * the current mode - Code sessions under a header per project, Chat sessions in one flat list.
 *
 * Configuration (Customize, Models) and the account live in the rail's avatar menu, not here:
 * this column lists where the user works. New behaves identically in both modes.
 */
export function SessionList({
  sessions,
  mode,
  loading,
  activeId,
  statuses,
  prSummaries,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onOpenArtifacts,
  onOpenMissionControl,
  onCreateInProject,
  onCreateInSection,
  onDelete,
  onTogglePin,
  onToggleArchived,
  onSetOrchestratorLabel,
  onRename,
  onDownload,
  renameError,
  onDismissRenameError,
  downloadError,
  onDismissDownloadError,
  sectionError,
  onDismissSectionError,
  userSections,
  sectionActions,
  syncHints,
  paging,
  searchSessions,
}: {
  sessions: ChatSessionSummary[];
  mode: ChatSessionMode;
  loading: boolean;
  activeId: string | null;
  /** What each session is doing, pushed from main. Absent means idle. */
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  /** Each session's PR, pushed from main. Absent means no PR to show. */
  prSummaries: ReadonlyMap<string, PrSummary>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  onOpenArtifacts: () => void;
  /** Every orchestration at a glance (missionControl/MissionControl.tsx). */
  onOpenMissionControl?: () => void;
  onCreateInProject: (directory: string) => void;
  /** New session that starts inside the user section with this id. */
  onCreateInSection: (sectionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  onToggleArchived: (session: ChatSessionSummary) => void;
  /** Overrides the row's orchestrator label; 'auto' hands it back to the automatic rule. */
  onSetOrchestratorLabel: (session: ChatSessionSummary, label: OrchestratorLabel) => void;
  onRename: (session: ChatSessionSummary, title: string) => void;
  onDownload: (session: ChatSessionSummary) => void;
  /** Set when a rename was refused and rolled back; cleared by clicking it. */
  renameError?: string | null;
  onDismissRenameError?: () => void;
  /** Set when saving a conversation to a file failed; cleared by clicking it. */
  downloadError?: string | null;
  onDismissDownloadError?: () => void;
  sectionError?: string | null;
  onDismissSectionError?: () => void;
  /** The user's own sections and which sessions sit in them; see useSidebarSections. */
  userSections: SidebarSectionsState;
  sectionActions: SidebarSectionActions;
  /** The sidebar's sync hint; `fallback` is the plain empty-list line, for it to replace or keep. */
  syncHints?: (empty: boolean, fallback: ReactNode) => ReactNode;
  /** Set when `sessions` is the loaded pages of a longer list; the end of the list loads more. */
  paging?: SessionListPaging;
  /** Title search across the whole list, for matches no page has loaded yet. */
  searchSessions?: SessionSearchFn;
}) {
  const [query, setQuery] = useState('');
  const remoteMatches = useSessionSearch(query, searchSessions);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const { results: historyResults, error: historyError } = useLocalHistory(query, sessions);
  // Declared above the collapsed early return, so collapsing and re-expanding comes back
  // to the width the user set rather than to the default.
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);

  // Sessions the query names by issue or PR number. They head the results, so they are left out
  // of the title matches below rather than listed twice.
  const refHits = useMemo(
    () =>
      findSessionsByRef(
        query,
        sessions.filter(session => session.mode === mode),
        prSummaries
      ),
    [sessions, mode, query, prSummaries]
  );

  // Loaded rows first (they carry any local edit), then the host's matches from unloaded pages.
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    const hitIds = new Set(refHits.map(hit => hit.session.id));
    const matches = (session: ChatSessionSummary) =>
      !hitIds.has(session.id) && session.title.toLowerCase().includes(needle);
    return withRows(sessions.filter(matches), remoteMatches.sessions.filter(matches));
  }, [sessions, query, refHits, remoteMatches]);

  const searchInput = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [importedOpen, setImportedOpen] = useState(false);
  const [importedInline] = useImportedInline();
  const [nested] = useNestedSessions();
  const sortByAttention = usePrAttentionSort(state => state.sortByAttention);
  // Only a dependency while the sort is on, so PR updates do not regroup the default sidebar.
  const rankedPrs = sortByAttention ? prSummaries : null;
  const foldedIds = useFoldedParents();

  // `section` is set when the right-click landed in a user section, which then offers a new session in
  // it and a rename.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; section?: SidebarSection } | null>(null);
  const [draggedSession, setDraggedSession] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const dragFrame = useRef(0);
  const [nameRequest, setNameRequest] = useState<SectionNameRequest | null>(null);
  const [messageTarget, setMessageTarget] = useState<ChatSessionSummary | null>(null);
  const requestRename = (section: SidebarSection) =>
    setNameRequest({ kind: 'rename', sectionId: section.id, currentName: section.name });

  const searching = query.trim() !== '';
  const sections = useMemo(() => {
    // A search lists matches flat: a tree would hide a match inside a parent that did not match.
    const attentionRank = rankedPrs
      ? (session: ChatSessionSummary) => prAttentionRank(rankedPrs.get(session.id))
      : undefined;
    const grouped = groupSessions(matching, mode, userSections, importedInline, nested && !searching, attentionRank);
    // An empty section under a search is only noise; with no query it stays so it can be found.
    return searching ? { ...grouped, custom: grouped.custom.filter(group => group.sessions.length > 0) } : grouped;
  }, [matching, mode, userSections, searching, importedInline, nested, rankedPrs]);

  // Strings, not the hint objects, reach the memoised rows, so an unrelated session update leaves them be.
  // No hints with nesting off: the setting brings back the plain flat list.
  const hints = useMemo(
    () => (nested ? parentHints(sessions, sections.children) : new Map<string, string>()),
    [nested, sessions, sections.children]
  );
  const orchestrators = useMemo(() => orchestratorLabels(sessions), [sessions]);

  const descendants = useMemo(() => {
    const cache = new Map<string, ChatSessionSummary[]>();
    return (session: ChatSessionSummary): ChatSessionSummary[] => {
      let found = cache.get(session.id);
      if (!found) cache.set(session.id, (found = descendantsOf(sections.children, session.id)));
      return found;
    };
  }, [sections]);

  // The open session's ancestors, as a key that only changes when the chain itself does, so a
  // fold the user makes later with the open session inside it is not undone by the next update.
  const activeAncestry = useMemo(() => {
    const parentOf = new Map<string, string>();
    for (const [parentId, children] of sections.children) {
      for (const child of children) parentOf.set(child.id, parentId);
    }
    const chain: string[] = [];
    for (let id = activeId && parentOf.get(activeId); id; id = parentOf.get(id)) chain.push(id);
    return chain.join('\n');
  }, [sections, activeId]);

  // Opening a sub-session from anywhere unfolds the branches it sits in, so it is never folded out
  // of sight. Cleared from the store rather than overridden, so the pill always shows what a click does.
  useEffect(() => {
    if (!activeAncestry) return;
    for (const id of activeAncestry.split('\n')) if (foldedParents().has(id)) toggleFolded(id);
  }, [activeAncestry]);

  // A fold gives way to a search, which would otherwise hide its own matches; the pill is inert
  // meanwhile, since a toggle could not show.
  const isFolded = useCallback((sessionId: string) => foldedIds.has(sessionId) && !searching, [foldedIds, searching]);
  const empty =
    refHits.length === 0 &&
    sections.pinned.length === 0 &&
    sections.custom.length === 0 &&
    sections.projects.length === 0 &&
    sections.loose.length === 0 &&
    sections.archived.length === 0 &&
    sections.imported.length === 0;
  const emptyLine = (
    <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }} data-testid="chat-sessions-empty">
      {mode === 'code' ? 'No Code sessions yet.' : 'No conversations yet.'}
    </Typography>
  );

  // Also open while it holds the open session, so clearing a search does not hide the selection.
  const importedShown = importedOpen || searching || sections.imported.some(session => session.id === activeId);
  const ordered = useMemo(
    () => [
      ...refHits.map(hit => hit.session),
      ...orderedSessions(sections, { isOpen: sessionId => !isFolded(sessionId), includeImported: importedShown }),
    ],
    [refHits, sections, importedShown, isFolded]
  );

  // Read inside the key handler so the listener is bound once rather than rebuilt on every
  // keystroke in the search box, which re-orders this list. The row actions read it for the
  // same reason: the shell hands down fresh callbacks on every render, and passing those to
  // the rows would redraw all of them each time.
  const target = useRef({
    ordered,
    collapsed,
    onSelect,
    onToggleCollapsed,
    onDelete,
    onTogglePin,
    onToggleArchived,
    onSetOrchestratorLabel,
    onRename,
    onDownload,
    sectionActions,
  });
  target.current = {
    ordered,
    collapsed,
    onSelect,
    onToggleCollapsed,
    onDelete,
    onTogglePin,
    onToggleArchived,
    onSetOrchestratorLabel,
    onRename,
    onDownload,
    sectionActions,
  };

  /**
   * A moved row keeps its updatedAt slot in the group it lands in, which on a long group is past
   * the cap - the row would leave one group and arrive hidden in the other.
   */
  const moveSession = useCallback((sessionId: string, sectionId: string | null) => {
    setRevealId(sessionId);
    target.current.sectionActions.move(sessionId, sectionId);
  }, []);

  const actions = useMemo<RowActions>(
    () => ({
      select: sessionId => target.current.onSelect(sessionId),
      remove: sessionId => target.current.onDelete(sessionId),
      togglePin: session => target.current.onTogglePin(session),
      toggleArchived: session => target.current.onToggleArchived(session),
      setOrchestratorLabel: (session, label) => target.current.onSetOrchestratorLabel(session, label),
      rename: (session, title) => target.current.onRename(session, title),
      download: session => target.current.onDownload(session),
      message: session => setMessageTarget(session),
      moveToSection: (sessionId, sectionId) => moveSession(sessionId, sectionId),
      requestNewSection: sessionId => setNameRequest({ kind: 'create', sessionId }),
      drag: sessionId => {
        cancelAnimationFrame(dragFrame.current);
        if (!sessionId) {
          setDraggedSession(null);
          setDropTarget(null);
          return;
        }
        // A frame late: Chromium drops a drag whose dragstart reflows the list under it, and
        // starting one is what opens the empty sections' drop slots.
        dragFrame.current = requestAnimationFrame(() => setDraggedSession(sessionId));
      },
    }),
    [moveSession]
  );

  /**
   * Ctrl+1-9 on macOS (Alt+1-9 elsewhere) opens the nth row, counted the way the sidebar draws
   * them and filtered the way the search box currently has them; the primary modifier plus a
   * digit picks a place on the rail (see rail/shortcuts.ts). Bound on the window rather than the
   * sidebar, because a user reaching for it is almost always typing in the composer at the time.
   * Mod+B is the shell's, since it must work in places that have no session list.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const nth = matchSessionShortcut(event);
      if (nth !== null) {
        const session = target.current.ordered[nth - 1];
        if (!session) return;
        event.preventDefault();
        target.current.onSelect(session.id);
        return;
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      // Mod+Shift+F as well as Mod+K: it is where find-across-everything sits in an editor, and
      // Mod+F alone finds in the open conversation. The orchestrator's focus toggle takes the
      // chord first while that view is up (see ViewSwitcher), and marks it handled.
      if (event.shiftKey) {
        if (event.code !== 'KeyF' || event.defaultPrevented) return;
        event.preventDefault();
        if (target.current.collapsed) target.current.onToggleCollapsed();
        setFocusRequest(request => request + 1);
        return;
      }

      // Focus the search, opening the sidebar first if it is collapsed; the effect below focuses
      // once the input exists.
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        if (target.current.collapsed) target.current.onToggleCollapsed();
        setFocusRequest(request => request + 1);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (focusRequest === 0 || collapsed) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [focusRequest, collapsed]);

  /**
   * A row, then - unless it is folded - every session it spawned beneath it, recursively. One
   * List holds the whole tree so the rails between rows meet. A flat array rather than a
   * Fragment: Joy's List clones each child to mark the first and last, which a Fragment refuses.
   */
  const tree = (
    session: ChatSessionSummary,
    depth: number,
    first: boolean,
    last: boolean,
    guides: string
  ): ReactNode[] => {
    const children = sections.children.get(session.id) ?? [];
    const under = descendants(session);
    const folded = isFolded(session.id);
    const childGuides = depth > 0 && depth <= MAX_NEST_DEPTH ? guides + (last ? '0' : '1') : guides;
    return [
      <SessionRow
        key={session.id}
        session={session}
        selected={session.id === activeId}
        status={statuses.get(session.id) ?? 'done'}
        pr={prSummaries.get(session.id)}
        userSections={userSections.sections}
        sectionId={sectionOf(userSections, session.id)}
        actions={actions}
        nestDepth={Math.min(depth, MAX_NEST_DEPTH)}
        nestDeeper={depth > MAX_NEST_DEPTH ? depth : 0}
        nestFirst={first}
        nestLast={last}
        nestGuides={guides}
        subCount={under.length}
        subActivity={loudestActivity(under, statuses)}
        subFolded={folded}
        subFoldable={!searching}
        hintTitle={hints.get(session.id)}
        orchestrator={orchestrators.shown.has(session.id)}
        orchestratorAutomatic={orchestrators.automatic.has(session.id)}
      />,
      ...(folded
        ? []
        : children.flatMap((child, index) =>
            tree(child, depth + 1, index === 0, index === children.length - 1, childGuides)
          )),
    ];
  };
  const row = (session: ChatSessionSummary) => tree(session, 0, false, false, '');
  const refRow = ({ session, match }: (typeof refHits)[number]) => (
    <SessionRow
      key={session.id}
      session={session}
      selected={session.id === activeId}
      status={statuses.get(session.id) ?? 'done'}
      pr={prSummaries.get(session.id)}
      userSections={userSections.sections}
      sectionId={sectionOf(userSections, session.id)}
      actions={actions}
      subFoldable={false}
      hintTitle={hints.get(session.id)}
      refChip={refLabel(match.ref)}
      orchestrator={orchestrators.shown.has(session.id)}
      orchestratorAutomatic={orchestrators.automatic.has(session.id)}
    />
  );

  const draggingSectionId = draggedSession ? sectionOf(userSections, draggedSession) : undefined;

  // dragover rather than dragenter, which flickers across a section's children. Stopped here so
  // the list around the section never sees it.
  const dragOverSection = (sectionId: string) => (event: DragEvent<HTMLElement>) => {
    if (!draggedSession || !event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = sectionId === draggingSectionId ? 'none' : 'move';
    if (dropTarget?.kind !== 'section' || dropTarget.sectionId !== sectionId) {
      setDropTarget({ kind: 'section', sectionId });
    }
  };

  const dropOnSection = (sectionId: string) => (event: DragEvent<HTMLElement>) => {
    const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE);
    if (!sessionId) return;
    event.preventDefault();
    event.stopPropagation();
    actions.drag(null);
    if (sectionOf(userSections, sessionId) !== sectionId) moveSession(sessionId, sectionId);
  };

  // Anywhere in the list outside a section takes a session out of its section; a row in no
  // section has nowhere new to go there, so it is not offered as a target at all.
  const dragOverList = (event: DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
    if (!draggingSectionId) {
      // Not prevented, so the list is no target; a section lit up on the way here still goes dark.
      event.dataTransfer.dropEffect = 'none';
      if (dropTarget !== null) setDropTarget(null);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget?.kind !== 'default') setDropTarget({ kind: 'default' });
  };

  const dropOnList = (event: DragEvent<HTMLElement>) => {
    const sessionId = event.dataTransfer.getData(SESSION_DRAG_TYPE);
    if (!sessionId) return;
    event.preventDefault();
    actions.drag(null);
    if (sectionOf(userSections, sessionId) !== undefined) moveSession(sessionId, null);
  };

  const customGroup = (group: CustomGroup) => (
    <Box
      key={group.section.id}
      onDragOver={dragOverSection(group.section.id)}
      onDrop={dropOnSection(group.section.id)}
      sx={{
        borderRadius: '8px',
        transition: 'background-color 120ms',
        ...(dropTarget?.kind === 'section' &&
          dropTarget.sectionId === group.section.id &&
          group.section.id !== draggingSectionId && { bgcolor: 'primary.softBg' }),
      }}
      data-testid="sidebar-section"
      data-section-id={group.section.id}
      data-drop-target={
        dropTarget?.kind === 'section' && dropTarget.sectionId === group.section.id ? 'true' : undefined
      }
    >
      <CustomSectionHeader
        section={group.section}
        onCreateSession={section => onCreateInSection(section.id)}
        onRename={requestRename}
        onDelete={section => sectionActions.remove(section.id)}
      />
      {group.sessions.length > 0 ? (
        <CappedSessionRows
          groupKey={`section:${group.section.id}`}
          testIdPrefix="sidebar-section"
          sessions={group.sessions}
          uncapped={searching}
          activeId={activeId}
          statuses={statuses}
          revealId={revealId}
          row={row}
          descendants={descendants}
        />
      ) : (
        // Nothing at rest, where a line of text read as a row; a dashed slot only while a row is in the air.
        draggedSession && (
          <Box
            sx={{
              mx: 0.5,
              my: 0.25,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '6px',
              border: '1px dashed',
              borderColor:
                dropTarget?.kind === 'section' && dropTarget.sectionId === group.section.id
                  ? 'primary.outlinedBorder'
                  : 'neutral.outlinedBorder',
            }}
            data-testid="sidebar-section-drop-zone"
          >
            <Typography level="body-xs" textColor="text.tertiary">
              Drop here
            </Typography>
          </Box>
        )
      )}
    </Box>
  );

  const submitSectionName = (name: string) => {
    if (!nameRequest) return;
    if (nameRequest.kind === 'create') sectionActions.create(name, nameRequest.sessionId);
    else sectionActions.rename(nameRequest.sectionId, name);
  };

  // Collapsed, the place rail beside this is all that shows; state above is kept for re-expanding.
  if (collapsed) return null;

  return (
    <Stack
      sx={{
        width,
        flexShrink: 0,
        position: 'relative',
        borderRight: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.level1',
        height: '100%',
      }}
      data-testid="sidebar"
    >
      {/* Straddles the border, so the two pixels either side of the edge both work. */}
      <ResizeHandle
        edge="right"
        label="Resize sidebar"
        testId="sidebar-resize-handle"
        width={width}
        min={SIDEBAR_MIN_WIDTH}
        max={SIDEBAR_MAX_WIDTH}
        defaultWidth={SIDEBAR_DEFAULT_WIDTH}
        clamp={clampSidebarWidth}
        dragging={dragging}
        onWidth={setWidth}
        onCommit={writeSidebarWidth}
        onDraggingChange={setDragging}
        sx={{ right: -2 }}
      />
      <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, px: 1.5, pt: 1.5, pb: 1 }}>
        <Typography level="title-sm" sx={{ flex: 1, pl: 0.5 }} data-testid="sidebar-place-title">
          {mode === 'code' ? 'Code' : 'Chat'}
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

      <Stack spacing={0.25} sx={{ px: 1, pb: 1 }}>
        {/* One label and one behaviour in both modes: it makes a session and opens nothing.
            A Code session starts unbound and its chip row is where a project is chosen. */}
        <NavItem icon={<PlusIcon />} label="New" onClick={onCreate} testId="chat-new-session-btn" />
        {/* Not scoped to the open session: the list is the server's, so it spans machines and
            outlives the local session files. */}
        <NavItem icon={<ArtifactIcon />} label="Artifacts" onClick={onOpenArtifacts} testId="chat-artifacts-btn" />
        {onOpenMissionControl && (
          <NavItem
            icon={<MissionControlIcon />}
            label="Mission Control"
            onClick={onOpenMissionControl}
            testId="sidebar-mission-control-btn"
          />
        )}
        <Box sx={{ px: 0.5, pt: 0.5 }}>
          <Input
            size="sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' && query.trim() && ordered[0]) {
                event.preventDefault();
                onSelect(ordered[0].id);
              } else if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Search, or an issue / PR number"
            startDecorator={<SearchIcon />}
            slotProps={{ input: { ref: searchInput, 'data-testid': 'chat-search-input' } }}
          />
          {historyError && (
            <Alert size="sm" color="danger" data-testid="local-history-error">
              {historyError}
            </Alert>
          )}
          {historyResults.length > 0 && (
            <List
              size="sm"
              sx={{ maxHeight: '30vh', overflowY: 'auto', ...thinScrollbarSx }}
              data-testid="local-history-results"
            >
              {historyResults.map(result => (
                <ListItem key={result.id}>
                  <ListItemButton onClick={() => onSelect(result.sessionId)} data-testid="local-history-result">
                    <ListItemContent>
                      <Typography level="body-xs">
                        {result.kind === 'page' ? 'Page' : 'Conversation'}: {result.title}
                      </Typography>
                      <Typography level="body-xs" textColor="text.tertiary" noWrap>
                        {result.snippet.replace(/<\/?mark>/g, '')}
                      </Typography>
                    </ListItemContent>
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}
        </Box>
        {renameError && (
          <Alert
            size="sm"
            color="danger"
            variant="soft"
            sx={{ cursor: 'pointer', mx: 0.5 }}
            onClick={onDismissRenameError}
            data-testid="chat-rename-error"
          >
            {renameError}
          </Alert>
        )}
        {downloadError && (
          <Alert
            size="sm"
            color="danger"
            variant="soft"
            sx={{ cursor: 'pointer', mx: 0.5 }}
            onClick={onDismissDownloadError}
            data-testid="chat-download-error"
          >
            {downloadError}
          </Alert>
        )}
        {sectionError && (
          <Alert
            size="sm"
            color="danger"
            variant="soft"
            sx={{ cursor: 'pointer', mx: 0.5 }}
            onClick={onDismissSectionError}
            data-testid="chat-section-error"
          >
            {sectionError}
          </Alert>
        )}
      </Stack>

      <Box
        sx={{
          overflowY: 'auto',
          flex: 1,
          px: 1,
          pb: 1,
          ...thinScrollbarSx,
          // Inset so the outline never adds to the width or is clipped by the scroll edge.
          ...(dropTarget?.kind === 'default' && {
            boxShadow: 'inset 0 0 0 2px var(--joy-palette-primary-outlinedBorder)',
          }),
        }}
        onContextMenu={event => {
          const clicked = event.target instanceof Element ? event.target : null;
          if (clicked?.closest(OWN_CONTEXT_TARGETS)) return;
          event.preventDefault();
          const sectionId = clicked?.closest('[data-section-id]')?.getAttribute('data-section-id');
          const section = userSections.sections.find(entry => entry.id === sectionId);
          setContextMenu({ x: event.clientX, y: event.clientY, section });
        }}
        onDragOver={dragOverList}
        onDrop={dropOnList}
        onDragLeave={event => {
          // Only when the pointer leaves the list itself, not when it crosses into a child.
          if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) {
            setDropTarget(null);
          }
        }}
        data-drop-target={dropTarget?.kind === 'default' ? 'true' : undefined}
        data-testid="sidebar-session-scroll"
        ref={setScrollRoot}
      >
        {loading ? (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1 }}>
            Loading conversations...
          </Typography>
        ) : empty ? (
          searching || !syncHints ? (
            emptyLine
          ) : (
            syncHints(true, emptyLine)
          )
        ) : (
          <>
            {!searching && syncHints?.(false, null)}
            {refHits.length > 0 && (
              <Box data-testid="sidebar-ref-matches">
                <SectionLabel>Issues and pull requests</SectionLabel>
                <List size="sm" sx={SESSION_LIST_SX}>
                  {refHits.map(refRow)}
                </List>
              </Box>
            )}

            {sections.pinned.length > 0 && (
              <Box data-testid="sidebar-pinned">
                <SectionLabel>Pinned</SectionLabel>
                <List size="sm" sx={SESSION_LIST_SX}>
                  {sections.pinned.flatMap(row)}
                </List>
              </Box>
            )}

            {sections.custom.map(customGroup)}

            {sections.projects.map(group => (
              <Box key={group.directory} data-testid="project-group">
                <ProjectHeader group={group} onCreateInProject={target => onCreateInProject(target.directory)} />
                <CappedSessionRows
                  groupKey={`project:${group.directory}`}
                  testIdPrefix="sidebar-project"
                  sessions={group.sessions}
                  uncapped={searching}
                  activeId={activeId}
                  statuses={statuses}
                  revealId={revealId}
                  row={row}
                  descendants={descendants}
                />
              </Box>
            ))}

            {sections.loose.length > 0 && (
              <Box>
                {/* In Code mode these are the sessions with no project yet, and they sit under
                    the project groups - unlabelled they read as belonging to the last one. */}
                {(refHits.length > 0 ||
                  sections.pinned.length > 0 ||
                  sections.custom.length > 0 ||
                  sections.projects.length > 0) && (
                  <SectionLabel>{mode === 'code' ? 'No project' : 'Conversations'}</SectionLabel>
                )}
                <List size="sm" sx={SESSION_LIST_SX}>
                  {sections.loose.flatMap(row)}
                </List>
              </Box>
            )}

            {/* Shut by default so a first sync of hundreds of transcripts does not bury the
                user's own work; a search opens it, since a match hidden behind it is no match. */}
            {sections.imported.length > 0 && (
              <Box data-testid="sidebar-imported">
                <Button
                  fullWidth
                  size="sm"
                  variant="plain"
                  color="neutral"
                  onClick={() => setImportedOpen(open => !open)}
                  endDecorator={<ChevronIcon open={importedShown} />}
                  sx={{ justifyContent: 'flex-start', mt: 1, fontWeight: 'md' }}
                  data-testid="sidebar-imported-toggle-btn"
                >
                  <Box sx={{ flex: 1, textAlign: 'left' }}>Imported from Claude ({sections.imported.length})</Box>
                </Button>
                {importedShown && (
                  <List size="sm" sx={SESSION_LIST_SX}>
                    {sections.imported.flatMap(row)}
                  </List>
                )}
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
                    {sections.archived.flatMap(row)}
                  </List>
                )}
              </Box>
            )}
          </>
        )}
        {/* Outside the empty check: a mode with no row in the loaded pages may still have older ones. */}
        {!loading && !searching && paging && <SessionListFooter paging={paging} scrollRoot={scrollRoot} />}
        {searching && remoteMatches.total > remoteMatches.sessions.length && (
          <Typography
            level="body-xs"
            textColor="text.tertiary"
            sx={{ px: 1, py: 0.75 }}
            data-testid="sidebar-search-capped"
          >
            Showing the newest {remoteMatches.sessions.length} of {remoteMatches.total} matches. Type more to narrow the
            search.
          </Typography>
        )}
      </Box>

      {/* Anchored to a zero-size point at the cursor, since a Joy Menu has to hang off a button. */}
      <Dropdown open={contextMenu !== null} onOpenChange={(_event, open) => !open && setContextMenu(null)}>
        <MenuButton
          slots={{ root: 'span' }}
          slotProps={{
            root: {
              'aria-hidden': true,
              tabIndex: -1,
              style: {
                position: 'fixed',
                left: contextMenu?.x ?? 0,
                top: contextMenu?.y ?? 0,
                width: 0,
                height: 0,
                pointerEvents: 'none',
              },
            },
          }}
        />
        <Menu size="sm" placement="bottom-start" data-testid="sidebar-context-menu">
          {contextMenu?.section && (
            <MenuItem
              onClick={() => contextMenu.section && onCreateInSection(contextMenu.section.id)}
              data-testid="sidebar-context-new-in-section-btn"
            >
              New session in {contextMenu.section.name}
            </MenuItem>
          )}
          {contextMenu?.section && (
            <MenuItem
              onClick={() => contextMenu.section && requestRename(contextMenu.section)}
              data-testid="sidebar-context-rename-section-btn"
            >
              Rename section
            </MenuItem>
          )}
          <MenuItem onClick={onCreate} data-testid="sidebar-context-new-session-btn">
            New session
          </MenuItem>
          <MenuItem onClick={() => setNameRequest({ kind: 'create' })} data-testid="sidebar-context-new-section-btn">
            New section
          </MenuItem>
        </Menu>
      </Dropdown>

      {nameRequest && (
        <SectionNameDialog request={nameRequest} onSubmit={submitSectionName} onClose={() => setNameRequest(null)} />
      )}

      {messageTarget && <MessageSessionDialog session={messageTarget} onClose={() => setMessageTarget(null)} />}
    </Stack>
  );
}

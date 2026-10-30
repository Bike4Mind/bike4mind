import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
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
} from '@shared/chat';
import { useLocalHistory } from './localHistory';
import type { PrSummary } from '@shared/pullRequest';
import { sectionOf, type SidebarSection, type SidebarSectionsState } from '@shared/sidebarSections';
import { capRows, raisedRows, setGroupLimit, useGroupLimit } from './groupCap';
import { descendantsOf, groupSessions, orderedSessions, type CustomGroup, type ProjectGroup } from './grouping';
import { ImportedBadge } from './ImportedBadge';
import { useImportedInline } from './importedInline';
import { keepMenuOpen } from './keepMenuOpen';
import {
  ArrowLeftIcon,
  ArtifactIcon,
  CheckIcon,
  ChevronIcon,
  ModelsIcon,
  MoreIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SubSessionsIcon,
} from './icons';
import { toggleFolded, useFoldedParents, useNestedSessions } from './nestedSessions';
import { ModeSwitcher } from './ModeSwitcher';
import { ResizeHandle } from './ResizeHandle';
import { SectionNameDialog, type SectionNameRequest } from './SectionNameDialog';
import { thinScrollbarSx } from './layout';
import { SessionBadge } from './SessionBadge';
import { PREPARING_WORKTREE } from './chipState';
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
const NEST_INDENT = 18;
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
  /** Sessions anywhere under this one; 0 or absent on a row with none. */
  subCount?: number;
  /** The loudest state among them, which the fold pill wears while they are folded away. */
  subActivity?: SubActivity;
  subFolded?: boolean;
}

type SubActivity = 'needs-action' | 'processing' | undefined;

/**
 * The rails into a nested row: straight lines for every ancestor level still running, and a
 * rounded elbow from the parent's badge into this one. Drawn on the ListItem's pseudo-elements
 * so they cost no DOM, and outside the button so its hover and selected fill start at the indent.
 */
function railSx(depth: number, first: boolean, last: boolean, guides: string) {
  const indent = depth * NEST_INDENT;
  const straight = [...guides].flatMap((guide, level) => (guide === '1' ? [level] : []));
  if (!last) straight.push(depth - 1);
  const line = `linear-gradient(${RAIL_COLOR}, ${RAIL_COLOR})`;
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
    '&::after': {
      content: '""',
      position: 'absolute',
      zIndex: 1,
      pointerEvents: 'none',
      top: -(first ? FIRST_RAIL_REACH : ROW_GAP),
      height: `calc(50% + ${first ? FIRST_RAIL_REACH : ROW_GAP}px)`,
      left: BADGE_CENTER - NEST_INDENT,
      width: NEST_INDENT - BADGE_CENTER + ELBOW_END,
      borderLeft: `1px solid ${RAIL_COLOR}`,
      borderBottom: `1px solid ${RAIL_COLOR}`,
      borderBottomLeftRadius: '7px',
    },
  };
}

const pulse = keyframes({ '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } });

/**
 * The fold control on a parent row: a branch glyph and how many sessions hang under it. Folded,
 * it fills in, and takes on the colour of anything underneath that is working or waiting on the
 * user, so folding a busy tree away never hides that it needs attention.
 *
 * A span with a button role rather than a <button>, because it sits inside the row's own button.
 */
function FoldPill({
  sessionId,
  count,
  activity,
  folded,
}: {
  sessionId: string;
  count: number;
  activity: SubActivity;
  folded: boolean;
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
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-expanded={!folded}
      title={label}
      onClick={toggle}
      onDoubleClick={isolate}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle(event);
        }
      }}
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
        cursor: 'pointer',
        transition: 'background-color 120ms, color 120ms',
        color: folded && activity ? `${color}.plainColor` : 'text.tertiary',
        bgcolor: folded ? `${color}.softBg` : 'transparent',
        '& svg': { transition: 'transform 160ms', transform: folded ? 'none' : 'rotate(90deg) scaleY(-1)' },
        '&:hover': { bgcolor: `${color}.softHoverBg`, color: `${color}.softColor` },
        '&:focus-visible': { outline: '2px solid var(--joy-palette-focusVisible)', outlineOffset: '1px' },
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

/** One object for the whole list, stable across renders, so a memoized row only redraws when its own data does. */
interface RowActions {
  select: (sessionId: string) => void;
  remove: (sessionId: string) => void;
  togglePin: (session: ChatSessionSummary) => void;
  toggleArchived: (session: ChatSessionSummary) => void;
  rename: (session: ChatSessionSummary, title: string) => void;
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
        Move to
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
      onBlur={save}
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
  subCount = 0,
  subActivity,
  subFolded = false,
}: RowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<'main' | 'move'>('main');
  const [editing, setEditing] = useState(false);
  const needsAction = status === 'needs-action';
  // Main pushes the project once the worktree exists, which is what ends this.
  const preparing = status === 'processing' && awaitsWorktree(session.project);
  const { ref: titleRef, clipped } = useTitleClipped(session.title, editing);

  const onRenameDone = (next: string | null) => {
    setEditing(false);
    if (next) actions.rename(session, next);
  };

  return (
    <ListItem
      data-nest-depth={nestDepth || undefined}
      sx={{
        ...(nestDepth > 0 && railSx(nestDepth, nestFirst, nestLast, nestGuides)),
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
              <Menu size="sm" placement="bottom-end">
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
                    <MenuItem onClick={() => actions.togglePin(session)} data-testid="chat-pin-session-btn">
                      {session.pinned ? 'Unpin' : 'Pin'}
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        // Shut by hand: the Dropdown unmounts before it can report closing, and would
                        // otherwise come back open when editing ends.
                        setMenuOpen(false);
                        setEditing(true);
                      }}
                      data-testid="chat-rename-session-btn"
                    >
                      Rename
                    </MenuItem>
                    {!session.pinned && !session.archived && (
                      <MenuItem
                        onClick={event => {
                          keepMenuOpen(event);
                          setMenuView('move');
                        }}
                        data-testid="chat-move-session-btn"
                      >
                        <Box sx={{ flex: 1 }}>Move to</Box>
                        <ChevronIcon open={false} />
                      </MenuItem>
                    )}
                    <MenuItem onClick={() => actions.toggleArchived(session)} data-testid="chat-archive-session-btn">
                      {session.archived ? 'Unarchive' : 'Archive'}
                    </MenuItem>
                    <MenuItem
                      color="danger"
                      onClick={() => actions.remove(session.id)}
                      data-testid="chat-delete-session-btn"
                    >
                      Delete
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
        onClick={editing ? undefined : () => actions.select(session.id)}
        aria-expanded={subCount > 0 ? !subFolded : undefined}
        onKeyDown={event => {
          // A tree's own keys: right opens a folded parent, left folds an open one.
          if (subCount === 0 || editing) return;
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
          ...(needsAction && { boxShadow: 'inset 2px 0 0 var(--joy-palette-warning-solidBg)' }),
        }}
        data-testid="chat-session-item"
        data-session-status={status}
        data-session-pr-state={pr?.state}
      >
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0, width: '100%' }}>
          <SessionBadge status={status} pr={pr} />
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
          {!editing && session.importOrigin && <ImportedBadge origin={session.importOrigin} />}
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
              <FoldPill sessionId={session.id} count={subCount} activity={subActivity} folded={subFolded} />
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

/** A type of our own, so a drag of text, a link or files (see useFileDrop) is never taken for a row. */
const SESSION_DRAG_TYPE = 'application/x-b4m-session';

/** Where a dragged row would land: a section by id, or the default groups, out of any section. */
type DropTarget = { kind: 'section'; sectionId: string } | { kind: 'default' };

/** Rows a right-click in them should leave alone; the sidebar's own menu is for empty space. */
const OWN_CONTEXT_TARGETS = '[data-testid="chat-session-item"], input, textarea, [role="menu"]';

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
  prSummaries,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onCreate,
  onOpenArtifacts,
  onCreateInProject,
  onCreateInSection,
  onDelete,
  onTogglePin,
  onToggleArchived,
  onRename,
  renameError,
  onDismissRenameError,
  sectionError,
  onDismissSectionError,
  userSections,
  sectionActions,
  customize,
  onOpenModels,
  footer,
}: {
  sessions: ChatSessionSummary[];
  mode: ChatSessionMode;
  onModeChange: (mode: ChatSessionMode) => void;
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
  onCreateInProject: (directory: string) => void;
  /** New session that starts inside the user section with this id. */
  onCreateInSection: (sectionId: string) => void;
  onDelete: (sessionId: string) => void;
  onTogglePin: (session: ChatSessionSummary) => void;
  onToggleArchived: (session: ChatSessionSummary) => void;
  onRename: (session: ChatSessionSummary, title: string) => void;
  /** Set when a rename was refused and rolled back; cleared by clicking it. */
  renameError?: string | null;
  onDismissRenameError?: () => void;
  sectionError?: string | null;
  onDismissSectionError?: () => void;
  /** The user's own sections and which sessions sit in them; see useSidebarSections. */
  userSections: SidebarSectionsState;
  sectionActions: SidebarSectionActions;
  /** The Customize nav row, which carries its own attention badge. */
  customize?: ReactNode;
  onOpenModels?: () => void;
  footer?: ReactNode;
}) {
  const [query, setQuery] = useState('');
  const { results: historyResults, error: historyError } = useLocalHistory(query, sessions);
  // Declared above the collapsed rail's early return, so collapsing and re-expanding comes back
  // to the width the user set rather than to the default.
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(session => session.title.toLowerCase().includes(needle));
  }, [sessions, query]);

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [importedOpen, setImportedOpen] = useState(false);
  const [importedInline] = useImportedInline();
  const [nested] = useNestedSessions();
  const foldedIds = useFoldedParents();

  // `section` is set when the right-click landed in a user section, which then offers a new session in
  // it and a rename.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; section?: SidebarSection } | null>(null);
  const [draggedSession, setDraggedSession] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const dragFrame = useRef(0);
  const [nameRequest, setNameRequest] = useState<SectionNameRequest | null>(null);
  const requestRename = (section: SidebarSection) =>
    setNameRequest({ kind: 'rename', sectionId: section.id, currentName: section.name });

  const searching = query.trim() !== '';
  const sections = useMemo(() => {
    const grouped = groupSessions(matching, mode, userSections, importedInline, nested);
    // An empty section under a search is only noise; with no query it stays so it can be found.
    return searching ? { ...grouped, custom: grouped.custom.filter(group => group.sessions.length > 0) } : grouped;
  }, [matching, mode, userSections, searching, importedInline, nested]);

  const descendants = useMemo(() => {
    const cache = new Map<string, ChatSessionSummary[]>();
    return (session: ChatSessionSummary): ChatSessionSummary[] => {
      let found = cache.get(session.id);
      if (!found) cache.set(session.id, (found = descendantsOf(sections.children, session.id)));
      return found;
    };
  }, [sections]);

  // A fold gives way to a search, which would otherwise hide its own matches, and to the open
  // session, so selecting a sub-session from anywhere never leaves it folded out of sight.
  const isFolded = useCallback(
    (sessionId: string) =>
      foldedIds.has(sessionId) &&
      !searching &&
      !descendantsOf(sections.children, sessionId).some(session => session.id === activeId),
    [foldedIds, searching, sections, activeId]
  );
  const empty =
    sections.pinned.length === 0 &&
    sections.custom.length === 0 &&
    sections.projects.length === 0 &&
    sections.loose.length === 0 &&
    sections.archived.length === 0 &&
    sections.imported.length === 0;

  // Also open while it holds the open session, so clearing a search does not hide the selection.
  const importedShown = importedOpen || searching || sections.imported.some(session => session.id === activeId);
  const ordered = useMemo(
    () => orderedSessions(sections, { isOpen: sessionId => !isFolded(sessionId), includeImported: importedShown }),
    [sections, importedShown, isFolded]
  );

  // Read inside the key handler so the listener is bound once rather than rebuilt on every
  // keystroke in the search box, which re-orders this list. The row actions read it for the
  // same reason: the shell hands down fresh callbacks on every render, and passing those to
  // the rows would redraw all of them each time.
  const target = useRef({
    ordered,
    onSelect,
    onToggleCollapsed,
    onDelete,
    onTogglePin,
    onToggleArchived,
    onRename,
    sectionActions,
  });
  target.current = {
    ordered,
    onSelect,
    onToggleCollapsed,
    onDelete,
    onTogglePin,
    onToggleArchived,
    onRename,
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
      rename: (session, title) => target.current.onRename(session, title),
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
   * The modifier plus 1-9 opens the nth row, counted the way the sidebar draws them and
   * filtered the way the search box currently has them. Nothing advertises this any more -
   * the numbered badges were dropped and the More panel that documented it was removed - but
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
    const childGuides = depth > 0 ? guides + (last ? '0' : '1') : '';
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
        nestDepth={depth}
        nestFirst={first}
        nestLast={last}
        nestGuides={guides}
        subCount={under.length}
        subActivity={loudestActivity(under, statuses)}
        subFolded={folded}
      />,
      ...(folded
        ? []
        : children.flatMap((child, index) =>
            tree(child, depth + 1, index === 0, index === children.length - 1, childGuides)
          )),
    ];
  };
  const row = (session: ChatSessionSummary) => tree(session, 0, false, false, '');

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
        {onOpenModels && (
          <NavItem icon={<ModelsIcon />} label="Models" onClick={onOpenModels} testId="chat-models-btn" />
        )}
        <Box sx={{ px: 0.5, pt: 0.5 }}>
          <Input
            size="sm"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search conversations"
            startDecorator={<SearchIcon />}
            slotProps={{ input: { 'data-testid': 'chat-search-input' } }}
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
      >
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
                {(sections.pinned.length > 0 || sections.custom.length > 0 || sections.projects.length > 0) && (
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

      {footer}
    </Stack>
  );
}

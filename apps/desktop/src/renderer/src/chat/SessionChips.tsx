import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { SxProps } from '@mui/joy/styles/types';
import {
  branchHolder,
  type BranchCheckout,
  type BranchElsewhere,
  type ChatProject,
  type RecentFolder,
} from '@shared/chat';
import { describeChipRow, displayPath, type ChipRowState } from './chipState';
import { useHomeDirectory } from './homeDirectory';
import { BranchIcon, CheckIcon, CloseIcon, FolderIcon, FolderPlusIcon } from './icons';
import { contentColumnSx } from './layout';
import type { ProjectBindingController } from './useChat';
import { useRecentFolders } from './useRecentFolders';

/** Above this the branch list is long enough that filtering it beats scrolling it. */
const FILTER_THRESHOLD = 8;

/**
 * The branch filter, which keeps the caret.
 *
 * Joy's menu owns focus: it claims it when the menu opens, and claims it again whenever the
 * item list changes - which is every keystroke, because filtering rewrites the list. So the
 * caret is taken back after each render rather than only on mount, and the effect is
 * deliberately dependency-free for that reason. It runs only while the menu is open, since
 * this component mounts with the menu's children.
 */
function BranchFilter({
  value,
  onChange,
  onCommit,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Enter on a name that is not an existing branch: start that branch. */
  onCommit: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (document.activeElement !== input.current) input.current?.focus();
  });

  return (
    <Box sx={{ px: 1, pb: 0.5 }}>
      <Input
        size="sm"
        value={value}
        placeholder="Filter or name a new branch..."
        onChange={event => onChange(event.target.value)}
        // Typing must reach the box: Joy's menu reads printable keys as type-ahead and
        // moves the highlight instead, eating every character after the first.
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === 'Enter') onCommit();
        }}
        slotProps={{ input: { 'data-testid': 'session-chip-branch-filter', ref: input } }}
      />
    </Box>
  );
}

/** The controller plus what the chips currently say; see `describeChipRow`. */
type ChipBinding = ProjectBindingController & { chips: ChipRowState };

/**
 * The height every control in this row is drawn at.
 *
 * Set by the branch pill, the one control here whose height is content-driven rather than
 * declared: an 18px body-xs line inside a Joy button's 4px block padding, plus the pill's own
 * border. Every Joy `sm` default lands under it - a Chip is 20px, an IconButton 24 - so each
 * control is pinned to this number instead of left to find its own.
 */
const ROW_HEIGHT = 28;

/** One pill in the row: the frame, with its controls drawn plain inside it. */
const pillSx: SxProps = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  minHeight: ROW_HEIGHT,
  borderRadius: '999px',
  border: '1px solid',
  borderColor: 'neutral.outlinedBorder',
  bgcolor: 'background.surface',
};

/** Joy's `sm` Chip, brought up to the row - and in to `pillButtonSx`'s padding and gap. */
const chipSx: SxProps = {
  '--Chip-minHeight': `${ROW_HEIGHT}px`,
  '--Chip-paddingInline': '8px',
  gap: '6px',
};

/** A pill's inner button: no border or background of its own, the pill provides both. */
const pillButtonSx: SxProps = {
  fontWeight: 'normal',
  minHeight: 22,
  minWidth: 0,
  px: 1,
  '--Button-gap': '6px',
  borderRadius: '999px',
};

/** Chip tooltips put a path on a line of its own; the width cap is in theme.ts. */
const chipTooltipSx: SxProps = { whiteSpace: 'pre-line' };

/** The row's `gap: 0.75`, in px, for the arithmetic in `fittingDirectories`. */
const ROW_GAP = 6;

/** The narrowest a lone folder chip is still drawn at, cut short: its X and a few letters. */
const MIN_DIRECTORY_CHIP = 64;

/**
 * Marks a label the row may cut short with an ellipsis. The measurement adds back what each one
 * has lost, so the fixed chips are measured at the width they want, not the one they were given.
 */
const CLIPPABLE_LABEL = 'session-chip-clippable';

/** The `+n` chip: a MenuButton drawn as the folder chips are, at their size and weight. */
const moreChipSx: SxProps = {
  minHeight: ROW_HEIGHT,
  minWidth: 0,
  px: '8px',
  flexShrink: 0,
  borderRadius: '999px',
  fontWeight: 'md',
};

function lastSegments(path: string, count = 2): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= count ? path : `.../${parts.slice(-count).join('/')}`;
}

/**
 * A worktree path as the menu names it: its folder, the part that tells worktrees apart. The
 * parents are shared by every worktree in the project and only cost the row its width.
 */
function checkoutFolderName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The branch menu's width, set rather than left to content: a popper shrink-wraps its widest
 * row, and a long branch with a long checkout path beside it stretched the menu across the window.
 */
const BRANCH_MENU_WIDTH = 380;

/** Wide enough for a long folder name beside its remove button; the full path is in each tooltip. */
const FOLDER_MENU_WIDTH = 280;

/**
 * One Recent entry: picking it binds the folder with no dialog, and its own button forgets it.
 * The remove button stops the click so forgetting an entry does not also choose it; from the
 * keyboard, Delete or Backspace on the focused row forgets it.
 */
function RecentFolderItem({
  folder,
  current,
  onChoose,
  onRemove,
}: {
  folder: RecentFolder;
  current: boolean;
  onChoose: () => void;
  onRemove: () => void;
}) {
  return (
    <Tooltip title={folder.path} size="sm" variant="soft" placement="right" sx={chipTooltipSx}>
      <MenuItem
        selected={current}
        onClick={onChoose}
        onKeyDown={event => {
          if (event.key !== 'Delete' && event.key !== 'Backspace') return;
          event.preventDefault();
          onRemove();
        }}
        sx={{
          '& .recent-folder-remove': { opacity: 0 },
          '&:hover .recent-folder-remove, &:focus-visible .recent-folder-remove, &.Mui-focusVisible .recent-folder-remove':
            { opacity: 1 },
        }}
        data-testid="session-chip-project-recent"
        data-path={folder.path}
      >
        <ListItemDecorator>{current && <CheckIcon />}</ListItemDecorator>
        <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {folder.name}
        </Typography>
        <IconButton
          className="recent-folder-remove"
          size="sm"
          variant="plain"
          color="neutral"
          aria-label={`Remove ${folder.name} from recent folders`}
          tabIndex={-1}
          onClick={event => {
            event.stopPropagation();
            onRemove();
          }}
          sx={{ '--IconButton-size': '22px' }}
          data-testid="session-chip-project-recent-remove-btn"
        >
          <CloseIcon />
        </IconButton>
      </MenuItem>
    </Tooltip>
  );
}

/**
 * The project directory, as its folder name - and, before one is chosen, the way to choose it.
 *
 * Drawn in primary rather than neutral while unset, because on a new Code session this is the
 * one control that has to be found: nothing else the session can do works until it is answered.
 *
 * Always opens a menu - recent folders above "Open folder..." - rather than deciding from the
 * list it last read: that list is re-read on every open, so a folder recorded since then (the
 * first pick in this very session, say) shows up the next time without a remount.
 */
function ProjectChip({ binding, current }: { binding: ChipBinding; current: string | null }) {
  const { folder, unset } = binding.chips;
  const recent = useRecentFolders();
  const [open, setOpen] = useState(false);

  const onOpenChange = (_event: unknown, wantsOpen: boolean): void => {
    if (wantsOpen) recent.refresh();
    setOpen(wantsOpen);
  };

  const choose = (path: string): void => {
    setOpen(false);
    if (path !== current) void binding.chooseDirectory(path);
  };

  return (
    <Dropdown open={open} onOpenChange={onOpenChange}>
      <Tooltip title={folder.tooltip} size="sm" variant="soft" placement="top-start" sx={chipTooltipSx}>
        {/* Wrapped for the same reason as the worktree toggle below: a disabled button takes no
            pointer events, so the reason it is locked would be unreadable on the chip it is about. */}
        <Box sx={{ display: 'flex', minWidth: 0 }}>
          <MenuButton
            size="sm"
            variant={unset ? 'soft' : 'outlined'}
            color={unset ? 'primary' : 'neutral'}
            disabled={binding.busy || !folder.enabled}
            startDecorator={<FolderIcon />}
            sx={{ ...pillButtonSx, minHeight: ROW_HEIGHT }}
            slotProps={{ root: { 'data-testid': 'session-chip-project' } }}
          >
            <Typography level="body-xs" textColor="inherit" noWrap className={CLIPPABLE_LABEL}>
              {folder.label}
            </Typography>
          </MenuButton>
        </Box>
      </Tooltip>

      <Menu
        size="sm"
        placement="top-start"
        sx={{ maxHeight: 360, overflow: 'auto', width: FOLDER_MENU_WIDTH, maxWidth: 'calc(100vw - 32px)' }}
        data-testid="session-chip-project-menu"
      >
        {recent.folders.length > 0 && (
          <Typography level="body-xs" sx={{ px: 1.5, py: 0.5 }} data-testid="session-chip-project-recent-heading">
            Recent
          </Typography>
        )}
        {recent.folders.map(entry => (
          <RecentFolderItem
            key={entry.path}
            folder={entry}
            current={entry.path === current}
            onChoose={() => choose(entry.path)}
            onRemove={() => void recent.remove(entry.path)}
          />
        ))}
        {recent.folders.length > 0 && <ListDivider />}
        <MenuItem
          onClick={() => {
            setOpen(false);
            void binding.pickDirectory();
          }}
          data-testid="session-chip-project-open-folder"
        >
          <ListItemDecorator>
            <FolderPlusIcon />
          </ListItemDecorator>
          Open folder...
        </MenuItem>
      </Menu>
    </Dropdown>
  );
}

/**
 * Branch and worktree as one pill, split by a divider.
 *
 * They are paired rather than separate because a worktree belongs to a branch: two independent
 * controls would invite "worktree, no branch", which resolves to nothing the tools could run in.
 *
 * With no folder chosen the pill stays clickable and its menu carries the reason. A branch list
 * needs a repository, and "nothing to list" is a thing to say rather than a control to grey out.
 * Once the session has run here the opposite holds - nothing in the menu could be picked - so
 * the branch button is disabled and its tooltip says why.
 */
function BranchChip({
  project,
  binding,
  branches,
  elsewhere,
  home,
}: {
  project: ChatProject | null;
  binding: ChipBinding;
  branches: readonly string[];
  elsewhere: Readonly<Record<string, BranchCheckout>>;
  home: string;
}) {
  const [filter, setFilter] = useState('');
  const { branch: branchChip, worktree, branchNotice, unset, locked } = binding.chips;

  const matches = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return branches;
    return branches.filter(entry => entry.toLowerCase().includes(query));
  }, [branches, filter]);

  const typed = filter.trim();
  const canCreate = !unset && !locked && !!typed && !branches.includes(typed);
  // The pill's own label, so the marked entry is the branch the chip claims rather than the
  // one recorded at creation; 'no branch' matches nothing, which is the intended miss.
  const onNow = branchChip.label;

  return (
    <Box sx={pillSx} data-testid="session-chip-branch">
      <Dropdown onOpenChange={(_event, open) => open && setFilter('')}>
        <Tooltip title={branchChip.tooltip} size="sm" variant="soft" placement="top-start" sx={chipTooltipSx}>
          {/* Wrapped for the same reason as the worktree toggle: once locked the button is
              disabled, and the tooltip is then the only place its branch and reason are read. */}
          <Box sx={{ display: 'flex', minWidth: 0 }}>
            <MenuButton
              size="sm"
              variant="plain"
              color="neutral"
              disabled={binding.busy || !branchChip.enabled}
              startDecorator={<BranchIcon />}
              sx={pillButtonSx}
              slotProps={{ root: { 'data-testid': 'session-chip-branch-btn' } }}
            >
              <Typography level="body-xs" textColor="inherit" noWrap className={CLIPPABLE_LABEL}>
                {branchChip.label}
              </Typography>
            </MenuButton>
          </Box>
        </Tooltip>

        <Menu
          size="sm"
          placement="top-start"
          sx={{ maxHeight: 360, overflow: 'auto', width: BRANCH_MENU_WIDTH, maxWidth: 'calc(100vw - 32px)' }}
          data-testid="session-chip-branch-menu"
        >
          {branches.length > FILTER_THRESHOLD && (
            <BranchFilter
              value={filter}
              onChange={setFilter}
              onCommit={() => canCreate && void binding.setBranch(typed)}
            />
          )}

          {/* Always rendered, never conditional: Joy re-registers its menu items when the
              children change and pulls focus onto the first one, which would take the caret out
              of the filter box the moment a typed name stopped matching an existing branch. */}
          {!unset && !locked && (
            <MenuItem
              disabled={!canCreate}
              onClick={() => void binding.setBranch(typed)}
              data-testid="session-chip-branch-new"
            >
              <Typography level="body-sm" noWrap title={canCreate ? typed : undefined} sx={{ minWidth: 0 }}>
                {canCreate ? `Create ${typed}` : 'Type a name to start a new branch'}
              </Typography>
            </MenuItem>
          )}

          {matches.map(entry => {
            const held = branchHolder(elsewhere, entry);
            return (
              <MenuItem
                key={entry}
                disabled={locked}
                selected={entry === onNow}
                onClick={() => void binding.setBranch(entry)}
                data-testid="session-chip-branch-option"
              >
                <Typography
                  level="body-sm"
                  noWrap
                  title={entry}
                  sx={{ minWidth: 0 }}
                  data-testid="session-chip-branch-name"
                >
                  {entry === onNow ? '* ' : ''}
                  {entry}
                </Typography>
                {held && (
                  <Tooltip
                    title={heldTooltip(held, project?.workspace ?? false, home)}
                    size="sm"
                    variant="soft"
                    placement="right"
                    sx={chipTooltipSx}
                  >
                    {/* The outsized shrink factor makes the mark give up its width before the
                        branch name does, down to a floor that keeps the icon and a few letters;
                        the tooltip has the full path. */}
                    <Box
                      sx={{
                        ml: 'auto',
                        pl: 1.5,
                        minWidth: 64,
                        flexShrink: 1000,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        gap: 0.5,
                        color: 'text.tertiary',
                        '& > svg': { flexShrink: 0 },
                      }}
                      data-testid="session-chip-branch-elsewhere-label"
                    >
                      <FolderIcon />
                      <Typography level="body-xs" textColor="inherit" noWrap sx={{ minWidth: 0 }}>
                        {checkoutFolderName(held.path)}
                        {held.prunable ? ' (missing)' : ''}
                      </Typography>
                    </Box>
                  </Tooltip>
                )}
              </MenuItem>
            );
          })}

          {branchNotice && (
            <Typography
              level="body-xs"
              textColor="text.tertiary"
              sx={{ px: 1.5, py: 0.5, whiteSpace: 'normal' }}
              data-testid="session-chip-branch-notice"
            >
              {branchNotice}
            </Typography>
          )}
        </Menu>
      </Dropdown>

      <Box sx={{ width: '1px', flexShrink: 0, alignSelf: 'stretch', my: 0.5, bgcolor: 'neutral.outlinedBorder' }} />

      <Tooltip title={worktree.tooltip} size="sm" variant="soft" placement="top-start" sx={chipTooltipSx}>
        {/* The Box, not the Checkbox, carries the tooltip: a disabled input takes no pointer
            events, so the reason it is disabled would be unreadable on the one it applies to. */}
        <Box sx={{ px: 1, display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          <Checkbox
            size="sm"
            label={
              <Typography level="body-xs" textColor="inherit">
                {worktree.label}
              </Typography>
            }
            checked={project?.workspace ?? false}
            disabled={binding.busy || !worktree.enabled}
            onChange={event => void binding.setWorkspace(event.target.checked)}
            slotProps={{ input: { 'data-testid': 'session-chip-worktree-toggle' } }}
          />
        </Box>
      </Tooltip>
    </Box>
  );
}

/**
 * The full path behind a menu mark. With the toggle on the pick is only a base, so the mark is
 * information there rather than a warning, and the tooltip says as much.
 */
function heldTooltip(held: BranchCheckout, workspace: boolean, home: string): string {
  const where = held.prunable ? 'Held by a worktree whose folder is gone.' : 'Checked out in another folder.';
  const then = workspace
    ? 'With worktree on it is only the base, so that is fine.'
    : 'Picking it offers to work there or cut a worktree from it.';
  // Whole, unlike the chips' own paths: the menu mark is cut short, so this is where it is read.
  return `${where} ${then}\n${displayPath(held.path, home, Number.POSITIVE_INFINITY)}`;
}

/**
 * The two ways on from a toggle-off pick that git cannot check out here, in the slot the chip
 * row's refusals use. A prunable holder has no folder to move into, so only the cut is offered.
 */
function ElsewhereConfirm({
  message,
  elsewhere,
  binding,
}: {
  message: string;
  elsewhere: BranchElsewhere;
  binding: ProjectBindingController;
}) {
  return (
    <Alert
      size="sm"
      color="neutral"
      variant="soft"
      sx={{ mb: 1, alignItems: 'flex-start' }}
      data-testid="session-chip-elsewhere"
      endDecorator={
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="Dismiss"
          onClick={() => binding.dismissError()}
          data-testid="session-chip-elsewhere-dismiss-btn"
        >
          <CloseIcon />
        </IconButton>
      }
    >
      <Stack spacing={0.75}>
        <Typography level="body-sm" textColor="inherit" data-testid="session-chip-elsewhere-message">
          {message}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {!elsewhere.prunable && (
            <Button
              size="sm"
              variant="solid"
              color="primary"
              disabled={binding.busy}
              onClick={() => void binding.moveToCheckout(elsewhere)}
              data-testid="session-chip-elsewhere-use-btn"
            >
              Use the existing checkout
            </Button>
          )}
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            disabled={binding.busy}
            onClick={() => void binding.worktreeFrom(elsewhere.branch)}
            data-testid="session-chip-elsewhere-worktree-btn"
          >
            Create a worktree from it
          </Button>
        </Stack>
      </Stack>
    </Alert>
  );
}

/** The button that grants this session another folder; the grants themselves are drawn by `ChipRow`. */
function AddContextButton({ binding }: { binding: ChipBinding }) {
  const { addContext } = binding.chips;

  return (
    <Tooltip title={addContext.tooltip} size="sm" variant="soft" placement="top-start" sx={chipTooltipSx}>
      {/* Wrapped for the same reason as the worktree toggle: a disabled button shows no tooltip. */}
      <Box sx={{ display: 'flex', flexShrink: 0 }}>
        <IconButton
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={binding.busy || !addContext.enabled}
          onClick={() => void binding.addContextDirectory()}
          aria-label={addContext.label}
          sx={{ borderRadius: '999px', minWidth: ROW_HEIGHT, minHeight: ROW_HEIGHT }}
          data-testid="session-chip-add-context"
        >
          <FolderPlusIcon />
        </IconButton>
      </Box>
    </Tooltip>
  );
}

/**
 * How many folder chips to draw in `space`, the row's width less the fixed chips': all of them
 * if they fit, else as many as leave room for the `+n` chip after them, else one cut short
 * beside it, else none and `+n` alone. Every chip, `+n` included, is preceded by a gap.
 */
function fittingDirectories(space: number, widths: readonly number[], more: number): number {
  const all = widths.reduce((sum, width) => sum + ROW_GAP + width, 0);
  if (all <= space) return widths.length;

  let used = ROW_GAP + more;
  let count = 0;
  for (const width of widths) {
    if (used + ROW_GAP + width > space) break;
    used += ROW_GAP + width;
    count++;
  }
  if (count > 0) return count;
  // A lone folder cut short leaves nothing hidden, so it needs no room kept for `+n`.
  const left = widths.length > 1 ? space - used : space;
  return left - ROW_GAP >= MIN_DIRECTORY_CHIP ? 1 : 0;
}

/**
 * How many of `count` folder chips fit beside the fixed ones.
 *
 * Measured from a hidden strip holding every chip at its natural width, so a chip can be counted
 * before it is drawn and no layout is read during render. A change of folders is measured before
 * paint; a change of width - window, browser or terminal pane, a branch label git has just
 * answered - comes through the one observer and is read at most once a frame.
 */
function useFittingDirectories(count: number, key: string) {
  const row = useRef<HTMLDivElement>(null);
  const fixed = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [fitting, setFitting] = useState(count);

  const measure = useCallback(() => {
    if (!row.current || !fixed.current || !strip.current) return;
    const rowWidth = row.current.getBoundingClientRect().width;
    // Not laid out (a hidden pane, or no layout engine at all): keep the last answer.
    if (!rowWidth) return;
    const clipped = Array.from(fixed.current.querySelectorAll<HTMLElement>(`.${CLIPPABLE_LABEL}`)).reduce(
      (sum, label) => sum + Math.max(0, label.scrollWidth - label.clientWidth),
      0
    );
    const widths = Array.from(strip.current.children, child => child.getBoundingClientRect().width);
    const more = widths.pop() ?? 0;
    setFitting(fittingDirectories(rowWidth - fixed.current.getBoundingClientRect().width - clipped, widths, more));
  }, []);

  useLayoutEffect(measure, [measure, key]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    for (const element of [row.current, fixed.current, strip.current]) if (element) observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  return { row, fixed, strip, fitting: Math.min(fitting, count) };
}

/**
 * The fixed chips, then the extra folders this session may read - on one line, however many.
 *
 * The grants are drawn rather than hidden behind the button: they widen what the tools can
 * reach, and a permission nobody can see is one nobody can take back. So those that do not fit
 * are still counted, in a `+n` chip whose menu lists them and takes each one back.
 *
 * The fixed chips never go into `+n`. They only give up width, by cutting their labels short,
 * once no folder chip is left to give it up first.
 */
function ChipRow({
  children,
  directories,
  onRemove,
}: {
  children: ReactNode;
  directories: readonly string[];
  onRemove: (directory: string) => Promise<void>;
}) {
  const { row, fixed, strip, fitting } = useFittingDirectories(directories.length, directories.join('\n'));
  const hidden = directories.slice(fitting);

  return (
    <Box
      ref={row}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        minWidth: 0,
        // Clip, not hidden: a hidden box can still be scrolled sideways by focusing a chip in it.
        // The margin keeps the focus ring of a chip on the row's edge.
        overflow: 'clip',
        overflowClipMargin: '4px',
      }}
      data-testid="session-chip-row"
    >
      <Box
        ref={fixed}
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, flexShrink: fitting > 0 ? 0 : 1 }}
        data-testid="session-chip-fixed"
      >
        {children}
      </Box>

      {directories.slice(0, fitting).map(directory => (
        <DirectoryChip key={directory} directory={directory} onRemove={onRemove} />
      ))}
      {hidden.length > 0 && <HiddenDirectoriesMenu directories={hidden} onRemove={onRemove} />}

      <Box
        ref={strip}
        aria-hidden
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 'max-content',
          display: 'flex',
          visibility: 'hidden',
          pointerEvents: 'none',
          '& > *': { flexShrink: 0 },
        }}
        data-testid="session-chip-measure"
      >
        {directories.map(directory => (
          <Chip key={directory} size="sm" variant="soft" color="neutral" endDecorator={<CloseIcon />} sx={chipSx}>
            {lastSegments(directory)}
          </Chip>
        ))}
        {directories.length > 0 && (
          <Button size="sm" variant="soft" color="neutral" tabIndex={-1} sx={moreChipSx}>
            <Typography level="body-xs" textColor="inherit">
              +{directories.length}
            </Typography>
          </Button>
        )}
      </Box>
    </Box>
  );
}

/** Joy closes a Dropdown on any MenuItem click unless the click says otherwise. */
const keepMenuOpen = (event: SyntheticEvent) => {
  (event as SyntheticEvent & { defaultMuiPrevented?: boolean }).defaultMuiPrevented = true;
};

/**
 * The folders the row had no room for, behind a `+n` chip. Each is taken back the way its chip
 * would be: a click, Enter, Delete or its X.
 */
function HiddenDirectoriesMenu({
  directories,
  onRemove,
}: {
  directories: readonly string[];
  onRemove: (directory: string) => Promise<void>;
}) {
  const home = useHomeDirectory();

  // The removed item unmounts with the focus in it, which would leave the menu deaf to the
  // keyboard: arrows, Enter and Escape are all heard on the list. So focus moves on first.
  const remove = (directory: string, item: Element | null): void => {
    const items = Array.from(item?.parentElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.findIndex(entry => entry === item);
    (items[at + 1] ?? items[at - 1])?.focus();
    void onRemove(directory);
  };

  return (
    <Dropdown>
      <MenuButton
        size="sm"
        variant="soft"
        color="neutral"
        aria-label={`${directories.length} more shared folders`}
        sx={moreChipSx}
        slotProps={{ root: { 'data-testid': 'session-chip-more-dirs-btn' } }}
      >
        <Typography level="body-xs" textColor="inherit" noWrap>
          +{directories.length}
        </Typography>
      </MenuButton>

      <Menu
        size="sm"
        placement="top-start"
        sx={{ maxHeight: 360, overflow: 'auto', width: FOLDER_MENU_WIDTH, maxWidth: 'calc(100vw - 32px)' }}
        data-testid="session-chip-more-dirs-menu"
      >
        {directories.map(directory => (
          <Tooltip
            key={directory}
            title={displayPath(directory, home, Number.POSITIVE_INFINITY)}
            size="sm"
            variant="soft"
            placement="right"
            sx={chipTooltipSx}
          >
            <MenuItem
              onClick={event => {
                if (directories.length > 1) keepMenuOpen(event);
                remove(directory, event.currentTarget);
              }}
              onKeyDown={event => {
                if (event.key !== 'Delete' && event.key !== 'Backspace') return;
                event.preventDefault();
                remove(directory, event.currentTarget);
              }}
              data-testid="session-chip-more-dirs-item"
              data-path={directory}
            >
              <Typography level="body-sm" noWrap sx={{ flex: 1, minWidth: 0 }}>
                {lastSegments(directory)}
              </Typography>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label={`Stop sharing ${lastSegments(directory)}`}
                tabIndex={-1}
                onClick={event => {
                  event.stopPropagation();
                  remove(directory, event.currentTarget.closest('[role="menuitem"]'));
                }}
                sx={{ '--IconButton-size': '22px' }}
                data-testid="session-chip-more-dirs-remove-btn"
              >
                <CloseIcon />
              </IconButton>
            </MenuItem>
          </Tooltip>
        ))}
      </Menu>
    </Dropdown>
  );
}

/** One granted folder; clicking it takes the grant back. */
function DirectoryChip({ directory, onRemove }: { directory: string; onRemove: (directory: string) => Promise<void> }) {
  const home = useHomeDirectory();
  return (
    // Not cut in the middle: this is a grant, and the whole of what was granted is the point.
    <Tooltip
      title={displayPath(directory, home, Number.POSITIVE_INFINITY)}
      size="sm"
      variant="soft"
      placement="top-start"
      sx={chipTooltipSx}
    >
      <Chip
        size="sm"
        variant="soft"
        color="neutral"
        endDecorator={<CloseIcon />}
        onClick={() => void onRemove(directory)}
        sx={{ ...chipSx, minWidth: 0 }}
        data-testid="session-chip-context"
      >
        {lastSegments(directory)}
      </Chip>
    </Tooltip>
  );
}

/**
 * The folders a Chat session was granted from a `request_directory` card. A Chat session draws no
 * SessionChips row, and a grant nobody can see is one nobody can take back, so these get a row of
 * their own - drawn only while there is something in it.
 */
export function GrantedFolderChips({
  directories,
  onRemove,
}: {
  directories: readonly string[];
  onRemove: (directory: string) => Promise<void>;
}) {
  if (directories.length === 0) return null;
  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }} data-testid="session-granted-folders">
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        <FolderIcon />
        {directories.map(directory => (
          <DirectoryChip key={directory} directory={directory} onRemove={onRemove} />
        ))}
      </Stack>
    </Box>
  );
}

interface BranchReading {
  branches: string[];
  /** Branches another worktree has checked out, by name; see ProjectInspection. */
  elsewhere: Record<string, BranchCheckout>;
  isRepository: boolean;
  /** HEAD of the working directory; undefined until git has answered. */
  checkedOut: string | null | undefined;
}

interface BranchReader extends BranchReading {
  /** Ask git again now; see the pick in SessionChips. */
  refresh: () => void;
}

/** A reading plus the folders it describes, so one taken before a move can be told apart. */
interface KeyedReading extends BranchReading {
  of: string | null;
}

const PENDING: BranchReading = { branches: [], elsewhere: {}, isRepository: true, checkedOut: undefined };

/**
 * The branches of the directory this session is currently on, and the branch it is actually on.
 *
 * Re-read whenever the directory changes, because that is the whole reason the list is not
 * stored with the session: branch names belong to a repository, and the ones shown after a move
 * must be the new repository's. A null directory is an unbound session: there is no repository
 * to ask, so nothing is asked.
 *
 * A reading is returned only to the folders it was taken in. Between a move and the answer for
 * where the session has moved TO, the previous repository's branch is not a stale detail - it
 * is this chip's whole claim, so those few frames are spent saying nothing instead.
 *
 * The list comes from the project root while HEAD comes from the working directory, which are
 * the same folder unless the session runs in a worktree. Asking the root for both would report
 * the branch of a checkout this session never touches; asking the worktree for both would leave
 * the user no branch menu to escape with on a worktree that has since been deleted.
 */
function useBranches(directory: string | null, workingDirectory: string | null, settledTurns: number): BranchReader {
  const [state, setState] = useState<KeyedReading>({ ...PENDING, of: null });
  const [reread, setReread] = useState(0);
  const refresh = useCallback(() => setReread(count => count + 1), []);

  // HEAD moves without this app's help - a `git checkout` in a terminal, another session
  // taking the worktree - and a reading taken once at mount would keep naming the branch that
  // has gone. Focus is when the user has come back to look at the chip, so it is when to ask.
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  const key = keyOf(directory, workingDirectory);

  useEffect(() => {
    if (!directory) {
      setState({ branches: [], elsewhere: {}, isRepository: false, checkedOut: undefined, of: key });
      return;
    }
    let current = true;
    const workspace = workingDirectory ?? directory;
    void Promise.all([
      window.b4m.chat.inspectProject(directory),
      // Swallowed rather than awaited strictly: a worktree that has been deleted must still
      // leave the branch list standing, since that menu is the only way back out of it.
      workspace === directory ? null : window.b4m.chat.inspectProject(workspace).catch(() => null),
    ]).then(([inspected, inWorkspace]) => {
      if (!current) return;
      setState({
        branches: inspected.branches,
        elsewhere: notIn(inspected.checkedOutElsewhere ?? {}, workspace),
        isRepository: inspected.isRepository,
        checkedOut: (inWorkspace ?? inspected).currentBranch,
        of: key,
      });
    });
    return () => {
      current = false;
    };
    // A reply that has ended is the other way HEAD moves: the agent's own tools run in this
    // working directory, and `git switch` from one of them never blurs the window, so the
    // focus listener above is blind to exactly the branch changes this app caused itself.
  }, [directory, workingDirectory, key, reread, settledTurns]);

  return { ...(state.of === key ? state : PENDING), refresh };
}

/**
 * The listing excludes the folder it was asked about, which is the project root; a session in a
 * worktree of its own is not "elsewhere" from itself either.
 */
function notIn(checkouts: Record<string, BranchCheckout>, workingDirectory: string): Record<string, BranchCheckout> {
  return Object.fromEntries(Object.entries(checkouts).filter(([, held]) => held.path !== workingDirectory));
}

function keyOf(directory: string | null, workingDirectory: string | null): string | null {
  return directory && `${directory}\n${workingDirectory ?? directory}`;
}

/** Shared, so a session with no grants hands `directories` the same array every render. */
const NO_DIRECTORIES: readonly string[] = [];

/**
 * What a Code session is grounded in, above the composer, editable at any point in the session.
 *
 * Drawn for EVERY Code session, including one that has chosen nothing yet - the unset chips are
 * how a project gets chosen, not a readout of a choice already made elsewhere. A Chat session
 * has no project and draws nothing here.
 */
export function SessionChips({
  project,
  grantedDirectories = NO_DIRECTORIES,
  binding,
  settledTurns,
  inUse = false,
}: {
  project: ChatProject | null;
  /** Folders added from a `request_directory` card while the session had no project to hold them. */
  grantedDirectories?: readonly string[];
  binding: ProjectBindingController;
  /** Monotonic count of replies this window has watched end; see useBranches. */
  settledTurns: number;
  /**
   * True once this conversation has anything in its transcript, which is when its grounding
   * stops being editable. A boolean rather than the messages themselves: the row re-renders on
   * every streamed chunk, and a length is the only thing about them it needs.
   */
  inUse?: boolean;
}) {
  const { branches, elsewhere, isRepository, checkedOut, refresh } = useBranches(
    project?.directory ?? null,
    project?.workingDirectory ?? null,
    settledTurns
  );
  const picked = project?.branch ?? '';
  // Unknown until git answers: the list is empty meanwhile, which is not evidence of a new name.
  const pickedExists = checkedOut === undefined ? undefined : !picked || branches.includes(picked);
  const elsewhereCount = Object.keys(elsewhere).length;
  const home = useHomeDirectory();
  const chips = useMemo(
    () =>
      describeChipRow(
        project,
        { isRepository, count: branches.length, checkedOut, pickedExists, elsewhereCount },
        inUse,
        home
      ),
    [project, isRepository, branches.length, checkedOut, pickedExists, elsewhereCount, inUse, home]
  );
  // A toggle-off pick switches HEAD without changing either folder useBranches is keyed on, so
  // nothing else would re-read it before the next focus; a created branch also joins the list.
  const { setBranch } = binding;
  const pickBranch = useCallback(
    async (branch: string) => {
      try {
        await setBranch(branch);
      } finally {
        refresh();
      }
    },
    [setBranch, refresh]
  );
  const bound = useMemo(() => ({ ...binding, setBranch: pickBranch, chips }), [binding, pickBranch, chips]);

  const dismiss = useCallback(() => binding.dismissError(), [binding]);

  const contextDirectories = project?.contextDirectories;
  const directories = useMemo(() => {
    const all = [...(contextDirectories ?? []), ...grantedDirectories];
    return all.filter((directory, index) => all.indexOf(directory) === index);
  }, [contextDirectories, grantedDirectories]);

  return (
    <Box sx={{ ...contentColumnSx, pt: 1 }}>
      {binding.error?.elsewhere ? (
        <ElsewhereConfirm message={binding.error.message} elsewhere={binding.error.elsewhere} binding={binding} />
      ) : (
        binding.error && (
          <Alert
            size="sm"
            color={binding.error.busy ? 'warning' : 'danger'}
            variant="soft"
            sx={{ mb: 1, cursor: 'pointer' }}
            onClick={dismiss}
            data-testid="session-chip-error"
          >
            {binding.error.message}
          </Alert>
        )
      )}

      <ChipRow directories={directories} onRemove={binding.removeContextDirectory}>
        <ProjectChip binding={bound} current={project?.directory ?? null} />
        <BranchChip project={project} binding={bound} branches={branches} elsewhere={elsewhere} home={home} />
        <AddContextButton binding={bound} />
      </ChipRow>
    </Box>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Checkbox from '@mui/joy/Checkbox';
import Chip from '@mui/joy/Chip';
import Dropdown from '@mui/joy/Dropdown';
import IconButton from '@mui/joy/IconButton';
import Input from '@mui/joy/Input';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import Typography from '@mui/joy/Typography';
import type { SxProps } from '@mui/joy/styles/types';
import type { BranchCheckout, BranchElsewhere, ChatProject } from '@shared/chat';
import { describeChipRow, type ChipRowState } from './chipState';
import { BranchIcon, CloseIcon, FolderIcon, FolderPlusIcon } from './icons';
import { contentColumnSx } from './layout';
import type { ProjectBindingController } from './useChat';

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
  px: 1,
  '--Button-gap': '6px',
  borderRadius: '999px',
};

function lastSegments(path: string, count = 2): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length <= count ? path : `.../${parts.slice(-count).join('/')}`;
}

/** A worktree path as the menu names it: relative to the project when it is inside it. */
function shortCheckoutPath(path: string, root: string | undefined): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : lastSegments(path);
}

/**
 * The project directory, as its folder name - and, before one is chosen, the way to choose it.
 *
 * Drawn in primary rather than neutral while unset, because on a new Code session this is the
 * one control that has to be found: nothing else the session can do works until it is answered.
 */
function ProjectChip({ binding }: { binding: ChipBinding }) {
  const { folder, unset } = binding.chips;
  return (
    <Tooltip title={folder.tooltip} size="sm" variant="soft" placement="top-start">
      {/* Wrapped for the same reason as the worktree toggle below: a disabled Chip takes no
          pointer events, so the reason it is locked would be unreadable on the chip it is about. */}
      <Box sx={{ display: 'flex' }}>
        <Chip
          size="sm"
          variant={unset ? 'soft' : 'outlined'}
          color={unset ? 'primary' : 'neutral'}
          disabled={binding.busy || !folder.enabled}
          startDecorator={<FolderIcon />}
          onClick={() => void binding.pickDirectory()}
          sx={chipSx}
          data-testid="session-chip-project"
        >
          {folder.label}
        </Chip>
      </Box>
    </Tooltip>
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
}: {
  project: ChatProject | null;
  binding: ChipBinding;
  branches: readonly string[];
  elsewhere: Readonly<Record<string, BranchCheckout>>;
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
        <Tooltip title={branchChip.tooltip} size="sm" variant="soft" placement="top-start">
          {/* Wrapped for the same reason as the worktree toggle: once locked the button is
              disabled, and the tooltip is then the only place its branch and reason are read. */}
          <Box sx={{ display: 'flex' }}>
            <MenuButton
              size="sm"
              variant="plain"
              color="neutral"
              disabled={binding.busy || !branchChip.enabled}
              startDecorator={<BranchIcon />}
              sx={pillButtonSx}
              slotProps={{ root: { 'data-testid': 'session-chip-branch-btn' } }}
            >
              <Typography level="body-xs" textColor="inherit" noWrap>
                {branchChip.label}
              </Typography>
            </MenuButton>
          </Box>
        </Tooltip>

        <Menu size="sm" placement="top-start" sx={{ maxHeight: 360, overflow: 'auto', minWidth: 280 }}>
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
              <Typography level="body-sm" noWrap>
                {canCreate ? `Create ${typed}` : 'Type a name to start a new branch'}
              </Typography>
            </MenuItem>
          )}

          {matches.map(entry => {
            const held = elsewhere[entry];
            return (
              <MenuItem
                key={entry}
                disabled={locked}
                selected={entry === onNow}
                onClick={() => void binding.setBranch(entry)}
                data-testid="session-chip-branch-option"
              >
                <Typography level="body-sm" noWrap data-testid="session-chip-branch-name">
                  {entry === onNow ? '* ' : ''}
                  {entry}
                </Typography>
                {held && (
                  <Tooltip
                    title={heldTooltip(held, project?.workspace ?? false)}
                    size="sm"
                    variant="soft"
                    placement="right"
                  >
                    <Typography
                      level="body-xs"
                      textColor="text.tertiary"
                      noWrap
                      startDecorator={<FolderIcon />}
                      sx={{ ml: 'auto', pl: 1.5, minWidth: 0 }}
                      data-testid="session-chip-branch-elsewhere-label"
                    >
                      {shortCheckoutPath(held.path, project?.directory)}
                      {held.prunable ? ' (missing)' : ''}
                    </Typography>
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

      <Box sx={{ width: '1px', alignSelf: 'stretch', my: 0.5, bgcolor: 'neutral.outlinedBorder' }} />

      <Tooltip title={worktree.tooltip} size="sm" variant="soft" placement="top-start">
        {/* The Box, not the Checkbox, carries the tooltip: a disabled input takes no pointer
            events, so the reason it is disabled would be unreadable on the one it applies to. */}
        <Box sx={{ px: 1, display: 'flex', alignItems: 'center' }}>
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
function heldTooltip(held: BranchCheckout, workspace: boolean): string {
  const where = held.prunable
    ? `Held by a worktree at ${held.path}, whose folder is gone.`
    : `Checked out in ${held.path}.`;
  return workspace
    ? `${where} With worktree on this is only the base a new branch is cut from, so that is fine.`
    : `${where} Picking it offers to work in that folder, or to cut a worktree from it.`;
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

/**
 * The extra folders this session may read, and the button that adds one.
 *
 * The grants are drawn rather than hidden behind the button: they widen what the tools can
 * reach, and a permission nobody can see is one nobody can take back.
 */
function ContextChips({
  project,
  granted,
  binding,
}: {
  project: ChatProject | null;
  granted: readonly string[];
  binding: ChipBinding;
}) {
  const { addContext } = binding.chips;
  const directories = [...(project?.contextDirectories ?? []), ...granted];

  return (
    <>
      <Tooltip title={addContext.tooltip} size="sm" variant="soft" placement="top-start">
        {/* Wrapped for the same reason as the worktree toggle: a disabled button shows no tooltip. */}
        <Box sx={{ display: 'flex' }}>
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

      {directories
        .filter((directory, index) => directories.indexOf(directory) === index)
        .map(directory => (
          <DirectoryChip key={directory} directory={directory} onRemove={binding.removeContextDirectory} />
        ))}
    </>
  );
}

/** One granted folder; clicking it takes the grant back. */
function DirectoryChip({ directory, onRemove }: { directory: string; onRemove: (directory: string) => Promise<void> }) {
  return (
    <Tooltip title={directory} size="sm" variant="soft" placement="top-start">
      <Chip
        size="sm"
        variant="soft"
        color="neutral"
        endDecorator={<CloseIcon />}
        onClick={() => void onRemove(directory)}
        sx={chipSx}
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

/**
 * What a Code session is grounded in, above the composer, editable at any point in the session.
 *
 * Drawn for EVERY Code session, including one that has chosen nothing yet - the unset chips are
 * how a project gets chosen, not a readout of a choice already made elsewhere. A Chat session
 * has no project and draws nothing here.
 */
export function SessionChips({
  project,
  grantedDirectories = [],
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
  const chips = useMemo(
    () =>
      describeChipRow(
        project,
        { isRepository, count: branches.length, checkedOut, pickedExists, elsewhereCount },
        inUse
      ),
    [project, isRepository, branches.length, checkedOut, pickedExists, elsewhereCount, inUse]
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

      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.75 }}>
        <ProjectChip binding={bound} />
        <BranchChip project={project} binding={bound} branches={branches} elsewhere={elsewhere} />
        <ContextChips project={project} granted={grantedDirectories} binding={bound} />
      </Stack>
    </Box>
  );
}

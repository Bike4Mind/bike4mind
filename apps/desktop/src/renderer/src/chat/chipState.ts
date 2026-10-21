import { awaitsWorktree, type ChatProject } from '@shared/chat';

/**
 * What one chip in the row says and whether it can act yet.
 *
 * `enabled: false` is always paired with a `tooltip` that says WHY, because a chip the user
 * cannot click and cannot explain is indistinguishable from a broken one.
 */
export interface ChipDescription {
  label: string;
  tooltip: string;
  enabled: boolean;
}

/**
 * The whole row, for a session that may or may not have chosen a project yet.
 *
 * Split out of SessionChips.tsx so the unset state is assertable: this package renders no
 * components in tests, and the state that shipped broken was precisely the one nothing ever
 * constructed. The component reads its labels from here rather than duplicating the rules.
 */
export interface ChipRowState {
  /** True when no project has been chosen. The folder chip is then the picker, not a readout. */
  unset: boolean;
  /** True once the session has run here and its grounding is fixed; see `describeChipRow`. */
  locked: boolean;
  folder: ChipDescription;
  branch: ChipDescription;
  worktree: ChipDescription;
  addContext: ChipDescription;
  /**
   * Line inside the branch menu: what the list cannot offer, or - when branches ARE listed -
   * what picking one of them will and will not do. Null only when there is nothing to add. Once
   * the row is locked the menu cannot open, so this is unseen there; the tooltip carries it.
   */
  branchNotice: string | null;
}

const CHOOSE_FOLDER_FIRST = 'Choose a folder first. Branches come from its repository.';

/**
 * The tail of every locked chip's tooltip, repeated on each because each is read on its own hover.
 *
 * The lock is a different refusal from `busy` and has to read as one. Busy is timing - the same
 * change works once the reply ends - while this one never clears: the transcript above already
 * describes commands that ran somewhere, and repointing the session would leave it claiming a
 * folder that work never happened in. Hence "fixed", never "wait".
 */
const FIXED = 'is fixed once the session starts.';

/** Past this a path line would wrap inside the tooltip's max width; see theme.ts. */
const PATH_MAX_LENGTH = 52;

/**
 * A path as a tooltip shows it: on its own line, home as `~`, and a long one cut in the middle so
 * the folder name at the end - the part that tells folders apart - survives.
 */
export function displayPath(path: string, home = '', max = PATH_MAX_LENGTH): string {
  const root = home.length > 1 ? home.replace(/\/+$/, '') : home;
  const short = root && (path === root || path.startsWith(`${root}/`)) ? `~${path.slice(root.length)}` : path;
  if (short.length <= max) return short;

  const parts = short.split('/');
  const headCount = parts[0] === '' ? 2 : 1;
  const head = parts.slice(0, headCount).join('/');
  let tail = parts[parts.length - 1];
  for (let index = parts.length - 2; index >= headCount; index--) {
    const longer = `${parts[index]}/${tail}`;
    if (head.length + '/.../'.length + longer.length > max) break;
    tail = longer;
  }
  const cut = `${head}/.../${tail}`;
  if (cut.length <= max) return cut;
  const keep = max - '...'.length;
  return `${short.slice(0, Math.ceil(keep / 3))}...${short.slice(-Math.floor((keep * 2) / 3))}`;
}

function withPath(sentence: string, path: string, home: string): string {
  return `${sentence}\n${displayPath(path, home)}`;
}

/** What the branch list turned out to be for the chosen folder; see useBranches. */
export interface BranchLookup {
  isRepository: boolean;
  count: number;
  /**
   * HEAD of the directory the session actually runs in, when that is a worktree and git could
   * be asked. Undefined means not looked up; null means detached, or not a repository.
   */
  checkedOut?: string | null;
  /**
   * False when `project.branch` is not in the list, which with the worktree toggle on means the
   * worktree is cut ONTO that new name rather than from it; see resolveWorkspace. Undefined is
   * read as true.
   */
  pickedExists?: boolean;
  /** How many listed branches another worktree has checked out; see ProjectInspection. */
  elsewhereCount?: number;
}

/** Shown while git is still being asked, so no name is put up before one has been read. */
const READING_BRANCH = '...';

/**
 * The chip row reads the branch from `checkedOut`, with one exception.
 *
 * `project.branch` is the branch this session RECORDED, and it goes on naming a checkout that is
 * gone the moment anything switches the working directory - another session, or a `git
 * checkout` in a terminal. It used to be the label whenever git had not answered, which is how
 * the chip came to state a branch the session was not on, so it is not evidence of where the
 * session runs. With the toggle off a pick is checked out in place (ChatService.checkoutInPlace),
 * which is how the chip follows it: through HEAD, like any other switch.
 *
 * The exception is a worktree that is asked for and not yet cut. There is no checkout of the
 * session's own to read, and the main checkout's HEAD is a branch the session will never run
 * on; the pick is exactly what the first turn cuts from, so it is the honest label until then.
 */
export function describeChipRow(
  project: ChatProject | null,
  branches: BranchLookup,
  /**
   * True once this conversation has a message or a tool run behind it.
   *
   * The lock is on first USE rather than on creation. Freezing at creation would trap a user who
   * picked the wrong folder and noticed immediately, and it buys nothing: a transcript can only
   * start lying about where work happened once work has happened. Before that the chips are how
   * a session gets bound at all.
   */
  inUse = false,
  /** The user's home folder, for `~` in path lines; empty until it has been read. */
  home = ''
): ChipRowState {
  if (!project) {
    return {
      unset: true,
      locked: false,
      folder: {
        label: 'Choose a folder',
        tooltip: 'Choose the folder this session works in. Nothing runs until you do.',
        enabled: true,
      },
      // Still clickable: its menu is where the explanation lives, and a chip that can say why
      // it is empty is worth more than one greyed out with nothing to read.
      branch: { label: 'no branch', tooltip: CHOOSE_FOLDER_FIRST, enabled: true },
      worktree: { label: 'worktree', tooltip: CHOOSE_FOLDER_FIRST, enabled: false },
      addContext: {
        label: 'Add a context folder',
        tooltip: 'Choose a folder first. Context folders are extra reading beside it.',
        enabled: false,
      },
      branchNotice: CHOOSE_FOLDER_FIRST,
    };
  }

  const relocated = project.workingDirectory !== project.directory;

  return {
    unset: false,
    locked: inUse,
    folder: {
      label: project.name,
      tooltip: withPath(
        inUse ? `Folder ${FIXED} Start a new session to switch.` : 'Folder this session works in. Click to change.',
        project.directory,
        home
      ),
      enabled: !inUse,
    },
    branch: {
      label: branchLabel(project, branches),
      // Locked like the folder: a menu whose every entry is disabled is a dead end to click into.
      // What it used to say - the branch, and why it cannot change - moves into the tooltip.
      tooltip: inUse ? lockedBranchTooltip(project, branches) : branchTooltip(project, branches),
      enabled: !inUse,
    },
    worktree: {
      label: 'worktree',
      tooltip: worktreeTooltip(project, branches, relocated, inUse, home),
      enabled: branches.isRepository && !inUse,
    },
    // Never locked: a context folder is one more root, not where commands run, so adding one
    // leaves nothing in the transcript describing a place the session no longer names.
    addContext: {
      label: 'Add a context folder',
      tooltip: 'Share another folder this session may read and edit (or type /add-dir).',
      enabled: true,
    },
    branchNotice: inUse ? `Branch ${FIXED}` : branchNotice(project, branches),
  };
}

/**
 * Where the session runs, and - once it is in a worktree - which branch that worktree is on.
 *
 * The middle state has its own sentence because it is a real one the user sits in: the box is
 * ticked and nothing exists yet. Saying "runs in" there would name a folder that is not on
 * disk, and saying nothing would read as the toggle having failed.
 */
function worktreeTooltip(
  project: ChatProject,
  { isRepository }: BranchLookup,
  relocated: boolean,
  inUse: boolean,
  home: string
): string {
  if (relocated) {
    const on = project.workspaceBranch ? ` on ${project.workspaceBranch}` : '';
    const lock = inUse ? ` Worktree ${FIXED}` : '';
    return withPath(`Runs in its own worktree${on}.${lock}`, project.workingDirectory, home);
  }
  if (inUse) return `Worktree setting ${FIXED}`;
  if (!isRepository) return 'Worktrees need a git repository, and this folder is not one.';
  if (project.workspace) return 'A branch and worktree are cut from your pick on your first message.';
  return 'Run this session on its own branch, in its own git worktree.';
}

/** The branch the session is on, or will be cut from, or an admission that there is neither. */
function branchLabel(project: ChatProject, { checkedOut }: BranchLookup): string {
  if (awaitsWorktree(project) && project.branch) return project.branch;
  if (checkedOut === undefined) return READING_BRANCH;
  return checkedOut ?? 'no branch';
}

/**
 * Where the name on the chip came from, and what it is not.
 *
 * A session that picked a branch and has since been moved off it needs both names. A session
 * that picked NONE has no second name to give - the sentence used to trail off into "started
 * on ." - and that is the normal state of every session started from the group header's "+",
 * which carries the folder and leaves the branch to the user. See newSessionInProject.
 */
function branchTooltip(project: ChatProject, { checkedOut, isRepository, pickedExists }: BranchLookup): string {
  if (awaitsWorktree(project) && project.branch) {
    return pickedExists === false
      ? `Branch ${project.branch} and its worktree are created on your first message.`
      : `A new branch and worktree are cut from ${project.branch} on your first message.`;
  }
  if (checkedOut === undefined) return 'Reading the branch...';
  if (checkedOut === null) {
    return isRepository
      ? 'No branch: a detached HEAD, or git could not be read.'
      : 'Not a git repository, so there is no branch.';
  }
  if (checkedOut === project.branch) return `On ${checkedOut}. Click to switch branches.`;
  if (!project.branch) return `On ${checkedOut}. This session has not picked a branch.`;
  return `On ${checkedOut}, but this session recorded ${project.branch}.`;
}

/** The locked pill's one place to read from, so it has to name the branch itself. */
function lockedBranchTooltip(project: ChatProject, branches: BranchLookup): string {
  const { checkedOut } = branches;
  const mismatch =
    checkedOut && project.branch && project.branch !== checkedOut && !awaitsWorktree(project)
      ? ` This session recorded ${project.branch}.`
      : '';
  const lead = checkedOut ? `On ${branchLabel(project, branches)}.${mismatch}` : branchTooltip(project, branches);
  return `${lead} Branch ${FIXED}`;
}

/**
 * What a pick will do, which differs by an entire branch between the two toggle states: with it
 * off the folder itself is switched, with it on the folder is left alone and the pick is a base.
 */
function branchNotice(project: ChatProject, { isRepository, count, elsewhereCount = 0 }: BranchLookup): string | null {
  if (count === 0) return isRepository ? 'This repository has no branches yet.' : 'Not a git repository.';
  if (project.workspace) {
    // Two things the user cannot see and would otherwise get wrong. That picking `main` means
    // "start from main" rather than "work on main" - the readings differ by an entire branch.
    // And that nothing has happened yet, so changing the pick now is free.
    const pending = project.workspaceBranch
      ? ''
      : ' Nothing is cut until your first message, so you can still change this.';
    // A base is never checked out, so another worktree holding it is no obstacle - and the
    // marks in the list must not read as one.
    const held = elsewhereCount > 0 ? ' A branch checked out in another folder is a fine base too.' : '';
    return (
      'With worktree on, your pick is the BASE: this session gets a new branch cut from it, in ' +
      `its own worktree. Your pick is never checked out here.${held}${pending}`
    );
  }
  const held =
    elsewhereCount > 0
      ? ' A branch already checked out in another folder cannot be checked out here too: picking one ' +
        'offers to work in that folder, or to cut a worktree from it.'
      : '';
  // Said up front because the folder may be shared - with another session, or a terminal.
  return (
    'Picking a branch checks it out in the folder this session runs in. Uncommitted changes there, ' +
    `or another session running there, stop the switch. Turn on worktree to leave it as it is.${held}`
  );
}

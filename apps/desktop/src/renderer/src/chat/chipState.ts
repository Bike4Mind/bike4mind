import type { ChatProject } from '@shared/chat';

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
   * what picking one of them will and will not do. Null only when there is nothing to add.
   */
  branchNotice: string | null;
}

const CHOOSE_FOLDER_FIRST = 'Choose a project folder first - branches belong to a repository.';

/**
 * Why a bound chip is locked. One sentence, repeated on every control it applies to, because
 * each one is read on its own hover.
 *
 * The lock is a different refusal from `busy` and has to read as one. Busy is timing - the same
 * change works once the reply ends - while this one never clears: the transcript above already
 * describes commands that ran somewhere, and repointing the session would leave it claiming a
 * folder that work never happened in.
 */
const IN_USE =
  'This conversation has already run here. Start a new session to work somewhere else - ' +
  'moving this one would leave its transcript describing work done in a folder it no longer names.';

/** What the branch list turned out to be for the chosen folder; see useBranches. */
export interface BranchLookup {
  isRepository: boolean;
  count: number;
  /**
   * HEAD of the directory the session actually runs in, when that is a worktree and git could
   * be asked. Undefined means not looked up; null means detached, or not a repository.
   */
  checkedOut?: string | null;
}

/** Shown while git is still being asked, so no name is put up before one has been read. */
const READING_BRANCH = '...';

/**
 * The chip row reads the branch from `checkedOut` and from nowhere else.
 *
 * `project.branch` is the branch this session RECORDED, which is a different thing: with the
 * worktree toggle off nothing ever checks it out, so it names where the session runs only by
 * coincidence, and it goes on naming a checkout that is gone the moment anything switches the
 * working directory - another session, or a `git checkout` in a terminal. It used to be the
 * label whenever git had not answered, which is how the chip came to state a branch the
 * session was not on. It is still the user's choice and still what a spawned child inherits;
 * it is just not evidence of anything, so it labels nothing.
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
  inUse = false
): ChipRowState {
  if (!project) {
    return {
      unset: true,
      locked: false,
      folder: {
        label: 'Choose a folder',
        tooltip: 'Pick the folder this conversation works in. Nothing can run until you do.',
        enabled: true,
      },
      // Still clickable: its menu is where the explanation lives, and a chip that can say why
      // it is empty is worth more than one greyed out with nothing to read.
      branch: { label: 'no branch', tooltip: CHOOSE_FOLDER_FIRST, enabled: true },
      worktree: { label: 'worktree', tooltip: CHOOSE_FOLDER_FIRST, enabled: false },
      addContext: {
        label: 'Add a context folder',
        tooltip: 'Choose a project folder first - context folders are extra reading beside it.',
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
      tooltip: inUse ? `${project.directory}\n\n${IN_USE}` : project.directory,
      enabled: !inUse,
    },
    branch: {
      label: branchLabel(branches),
      // Still clickable when locked: the menu is where the branch this session is on, and the
      // reason it cannot change, are both readable.
      tooltip: inUse ? `${branchTooltip(project, branches)}\n\n${IN_USE}` : branchTooltip(project, branches),
      enabled: true,
    },
    worktree: {
      label: 'worktree',
      tooltip: inUse ? `${worktreeTooltip(project, relocated)}\n\n${IN_USE}` : worktreeTooltip(project, relocated),
      enabled: branches.isRepository && !inUse,
    },
    addContext: {
      label: 'Add a context folder',
      tooltip: inUse ? IN_USE : 'Add a folder this session may read',
      enabled: !inUse,
    },
    branchNotice: inUse ? IN_USE : branchNotice(project, branches),
  };
}

/** Where the session runs, and - once it is in a worktree - which branch that worktree is on. */
function worktreeTooltip(project: ChatProject, relocated: boolean): string {
  if (!relocated) return 'Run this session on its own branch, cut from the one picked, in its own git worktree';
  const on = project.workspaceBranch ? ` on ${project.workspaceBranch}` : '';
  return `Runs in the worktree at ${project.workingDirectory}${on}`;
}

/** The branch the session is on, or an admission that there is not one to show. */
function branchLabel({ checkedOut }: BranchLookup): string {
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
function branchTooltip(project: ChatProject, { checkedOut, isRepository }: BranchLookup): string {
  if (checkedOut === undefined) return `Reading the branch in ${project.workingDirectory}...`;
  if (checkedOut === null) {
    if (!isRepository) return `${project.directory} is not a git repository, so it has no branch.`;
    return `${project.workingDirectory} is not on any branch - a detached HEAD, or git could not be read.`;
  }
  if (checkedOut === project.branch) return project.directory;
  if (!project.branch) return `${project.workingDirectory} is on ${checkedOut}. This session has not picked a branch.`;
  return `${project.workingDirectory} is on ${checkedOut}; this session recorded ${project.branch}.`;
}

/**
 * With the toggle off, picking a branch writes `project.branch` and NOTHING else: no checkout
 * happens, in this directory or anywhere, so the chip goes on naming the branch that was
 * already there. Saying so in the menu is the honest half of that - the alternative readings
 * of a click that changes nothing are that the app is broken or that the user misclicked.
 */
function branchNotice(project: ChatProject, { isRepository, count, checkedOut }: BranchLookup): string | null {
  if (count === 0) return isRepository ? 'This repository has no branches yet.' : 'Not a git repository.';
  if (project.workspace) {
    // The worktree-on sentence after the branch became a base: picking `main` means "start from
    // main", not "work on main". Said here because the two readings differ by an entire branch,
    // and the one the user arrives with is the wrong one.
    return (
      'With worktree on, the branch you pick is the BASE: this session gets a new branch cut ' +
      'from it, in a worktree of its own. The branch you pick is never checked out here.'
    );
  }
  const stays = checkedOut ? ` ${project.workingDirectory} stays on ${checkedOut}.` : '';
  return (
    `Picking a branch records it for this session; nothing is checked out.${stays} ` +
    'Turn on worktree to run on the branch you pick.'
  );
}

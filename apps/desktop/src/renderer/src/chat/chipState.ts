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
  folder: ChipDescription;
  branch: ChipDescription;
  worktree: ChipDescription;
  addContext: ChipDescription;
  /** Line inside the branch menu when there is nothing to list; null when branches are listed. */
  branchNotice: string | null;
}

const CHOOSE_FOLDER_FIRST = 'Choose a project folder first - branches belong to a repository.';

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

/**
 * The chip row reads the branch from `checkedOut` rather than `project.branch`, because the two
 * diverge the moment anything switches the worktree afterwards - another session, or a
 * `git checkout` in a terminal - and the recorded name then labels a checkout that is gone.
 * Only the LABEL is reconciled: `project.branch` stays the user's choice, since it is also what
 * a spawned child inherits and what the session's system prompt names.
 */
export function describeChipRow(project: ChatProject | null, branches: BranchLookup): ChipRowState {
  if (!project) {
    return {
      unset: true,
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
  // undefined is "not looked up yet", which falls back rather than blanking the chip mid-render.
  const live = branches.checkedOut ?? null;

  return {
    unset: false,
    folder: { label: project.name, tooltip: project.directory, enabled: true },
    branch: {
      label: live ?? (project.branch || 'no branch'),
      tooltip: branchTooltip(project, live),
      enabled: true,
    },
    worktree: {
      label: 'worktree',
      tooltip: relocated
        ? `Runs in the worktree at ${project.workingDirectory}`
        : 'Run this session in its own git worktree for the branch, beside the project',
      enabled: branches.isRepository,
    },
    addContext: {
      label: 'Add a context folder',
      tooltip: 'Add a folder this session may read',
      enabled: true,
    },
    branchNotice: branchNotice(branches),
  };
}

/**
 * The label and the recorded branch disagree in two ways that do not read alike.
 *
 * A session that picked a branch and has since been moved off it needs both names. A session
 * that picked NONE has no second name to give - the sentence used to trail off into "started
 * on ." - and that is the normal state of every session started from the group header's "+",
 * which carries the folder and leaves the branch to the user. See newSessionInProject.
 */
function branchTooltip(project: ChatProject, live: string | null): string {
  if (!live || live === project.branch) return project.directory;
  if (!project.branch) return `${project.workingDirectory} is on ${live}. This session has not picked a branch.`;
  return `${project.workingDirectory} is on ${live}; this session was started on ${project.branch}.`;
}

function branchNotice({ isRepository, count }: BranchLookup): string | null {
  if (count > 0) return null;
  return isRepository ? 'This repository has no branches yet.' : 'Not a git repository.';
}

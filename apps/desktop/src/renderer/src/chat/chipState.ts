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
}

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

  return {
    unset: false,
    folder: { label: project.name, tooltip: project.directory, enabled: true },
    branch: { label: project.branch || 'no branch', tooltip: project.directory, enabled: true },
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

function branchNotice({ isRepository, count }: BranchLookup): string | null {
  if (count > 0) return null;
  return isRepository ? 'This repository has no branches yet.' : 'Not a git repository.';
}

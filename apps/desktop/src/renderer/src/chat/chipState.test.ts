import { describe, expect, it } from 'vitest';
import type { ChatProject } from '@shared/chat';
import { describeChipRow } from './chipState';

const project: ChatProject = {
  directory: '/Users/someone/code/thing',
  name: 'thing',
  branch: 'main',
  workspace: false,
  workingDirectory: '/Users/someone/code/thing',
  contextDirectories: [],
};

/**
 * The state that shipped broken: a Code session with no project chosen.
 *
 * Nothing rendered the chip row without one, so every chip's unset appearance was
 * unexercised - which is why a row that could not be reached at all passed the suite.
 */
describe('describeChipRow with no project chosen', () => {
  const row = describeChipRow(null, { isRepository: false, count: 0 });

  it('marks the row unset', () => {
    expect(row.unset).toBe(true);
  });

  it('turns the folder chip into the picker rather than a readout', () => {
    expect(row.folder.enabled).toBe(true);
    expect(row.folder.label).toBe('Choose a folder');
    expect(row.folder.tooltip).toMatch(/pick the folder/i);
  });

  it('leaves the branch chip clickable so its menu can say why it is empty', () => {
    expect(row.branch.enabled).toBe(true);
    expect(row.branchNotice).toMatch(/choose a project folder first/i);
  });

  it('disables the controls that cannot mean anything yet, each with a reason', () => {
    expect(row.worktree.enabled).toBe(false);
    expect(row.worktree.tooltip).toMatch(/choose a project folder first/i);
    expect(row.addContext.enabled).toBe(false);
    expect(row.addContext.tooltip).toMatch(/choose a project folder first/i);
  });

  it('never leaves a disabled chip without an explanation', () => {
    for (const chip of [row.folder, row.branch, row.worktree, row.addContext]) {
      if (!chip.enabled) expect(chip.tooltip.length).toBeGreaterThan(0);
    }
  });
});

describe('describeChipRow with a project', () => {
  it('shows the project and branch, and enables everything', () => {
    const row = describeChipRow(project, { isRepository: true, count: 3, checkedOut: 'main' });
    expect(row.unset).toBe(false);
    expect(row.folder.label).toBe('thing');
    expect(row.folder.tooltip).toBe(project.directory);
    expect(row.branch.label).toBe('main');
    expect(row.worktree.enabled).toBe(true);
    expect(row.addContext.enabled).toBe(true);
  });

  it('says a folder is not a repository instead of offering a worktree', () => {
    const row = describeChipRow({ ...project, branch: '' }, { isRepository: false, count: 0, checkedOut: null });
    expect(row.branch.label).toBe('no branch');
    expect(row.worktree.enabled).toBe(false);
    expect(row.branchNotice).toBe('Not a git repository.');
  });

  it('distinguishes an empty repository from one that is not a repository', () => {
    expect(describeChipRow(project, { isRepository: true, count: 0 }).branchNotice).toMatch(/no branches yet/i);
  });

  it('names the worktree in the toggle tooltip once the session has moved into one', () => {
    const relocated = { ...project, workspace: true, workingDirectory: '/Users/someone/code/feat+x' };
    expect(describeChipRow(relocated, { isRepository: true, count: 2 }).worktree.tooltip).toContain(
      '/Users/someone/code/feat+x'
    );
  });
});

/**
 * A worktree switched off the branch it was created for used to leave the chip naming a
 * checkout that no longer existed, with nothing on screen admitting the two had parted.
 */
describe('describeChipRow when the worktree has moved off its branch', () => {
  const relocated: ChatProject = {
    ...project,
    branch: 'agent/x',
    workspace: true,
    workingDirectory: '/Users/someone/code/agent+x',
  };

  it('labels the chip with the branch the worktree is on, not the one recorded', () => {
    const row = describeChipRow(relocated, { isRepository: true, count: 2, checkedOut: 'fix/x' });
    expect(row.branch.label).toBe('fix/x');
  });

  it('says in the tooltip which branch the session was started on', () => {
    const row = describeChipRow(relocated, { isRepository: true, count: 2, checkedOut: 'fix/x' });
    expect(row.branch.tooltip).toContain('fix/x');
    expect(row.branch.tooltip).toContain('agent/x');
  });

  it('leaves the tooltip alone when the two agree', () => {
    const row = describeChipRow(relocated, { isRepository: true, count: 2, checkedOut: 'agent/x' });
    expect(row.branch.label).toBe('agent/x');
    expect(row.branch.tooltip).toBe(relocated.directory);
  });
});

/**
 * The bug this file exists for: the chip answered with `project.branch` whenever git had not,
 * which is a branch nothing ever checked out. The user read a confident name off the chip, the
 * agent read a different one out of the same field, and neither was where the session ran.
 */
describe('describeChipRow when the live branch is not known', () => {
  const relocated: ChatProject = {
    ...project,
    branch: 'agent/x',
    workspace: true,
    workingDirectory: '/Users/someone/code/agent+x',
  };

  it('says nothing yet rather than naming the recorded branch, before git has answered', () => {
    const row = describeChipRow(relocated, { isRepository: true, count: 2 });
    expect(row.branch.label).not.toBe('agent/x');
    expect(row.branch.tooltip).toContain(relocated.workingDirectory);
  });

  it('admits a detached HEAD rather than naming the recorded branch', () => {
    const row = describeChipRow(relocated, { isRepository: true, count: 2, checkedOut: null });
    expect(row.branch.label).toBe('no branch');
    expect(row.branch.tooltip).toMatch(/not on any branch/i);
  });

  it('names no branch for a folder that is not a repository', () => {
    const row = describeChipRow({ ...project }, { isRepository: false, count: 0, checkedOut: null });
    expect(row.branch.label).toBe('no branch');
    expect(row.branch.tooltip).toMatch(/not a git repository/i);
  });
});

/**
 * Selecting a branch with the worktree toggle off writes `project.branch` and nothing else -
 * no checkout happens anywhere - so the chip goes on naming the branch already in place. The
 * menu is where that has to be admitted, or a click that changes nothing reads as a fault.
 */
describe('describeChipRow on what picking a branch will do', () => {
  it('says a pick is only recorded while the session runs outside a worktree', () => {
    const row = describeChipRow(project, { isRepository: true, count: 3, checkedOut: 'fix/elsewhere' });
    expect(row.branchNotice).toMatch(/nothing is checked out/i);
    expect(row.branchNotice).toContain('fix/elsewhere');
    expect(row.branchNotice).toMatch(/turn on worktree/i);
  });

  it('adds nothing once the session runs in a worktree, where a pick does move it', () => {
    const inWorktree = { ...project, workspace: true, workingDirectory: '/Users/someone/code/agent+x' };
    expect(describeChipRow(inWorktree, { isRepository: true, count: 3, checkedOut: 'main' }).branchNotice).toBeNull();
  });
});

/**
 * What the row says for a session that has a folder and no branch - the shape every session
 * started from the group header's "+" begins in.
 */
describe('describeChipRow for a session that has not picked a branch', () => {
  const unbound: ChatProject = { ...project, branch: '', workspace: false };

  it('labels the chip with what the folder is actually on', () => {
    const row = describeChipRow(unbound, { isRepository: true, count: 2, checkedOut: 'feat/achievements' });
    expect(row.branch.label).toBe('feat/achievements');
  });

  it('says the branch is unpicked rather than naming one the session never chose', () => {
    const row = describeChipRow(unbound, { isRepository: true, count: 2, checkedOut: 'feat/achievements' });
    expect(row.branch.tooltip).toContain('has not picked a branch');
    expect(row.branch.tooltip).not.toMatch(/started on \.$/);
  });

  it('names no branch before git has answered', () => {
    expect(describeChipRow(unbound, { isRepository: true, count: 2 }).branch.label).not.toBe('main');
  });
});

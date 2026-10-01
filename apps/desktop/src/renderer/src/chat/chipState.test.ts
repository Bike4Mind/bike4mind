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
    const row = describeChipRow(project, { isRepository: true, count: 3 });
    expect(row.unset).toBe(false);
    expect(row.folder.label).toBe('thing');
    expect(row.folder.tooltip).toBe(project.directory);
    expect(row.branch.label).toBe('main');
    expect(row.worktree.enabled).toBe(true);
    expect(row.addContext.enabled).toBe(true);
    expect(row.branchNotice).toBeNull();
  });

  it('says a folder is not a repository instead of offering a worktree', () => {
    const row = describeChipRow({ ...project, branch: '' }, { isRepository: false, count: 0 });
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

  it('falls back to the recorded branch before git has answered, and on a detached HEAD', () => {
    expect(describeChipRow(relocated, { isRepository: true, count: 2 }).branch.label).toBe('agent/x');
    expect(describeChipRow(relocated, { isRepository: true, count: 2, checkedOut: null }).branch.label).toBe('agent/x');
  });
});

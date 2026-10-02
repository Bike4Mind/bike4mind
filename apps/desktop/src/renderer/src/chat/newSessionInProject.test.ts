import type { ChatProject } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { newSessionInProject } from './newSessionInProject';

const SIBLING: ChatProject = {
  directory: '/Users/jude/Javascript/bike4mind',
  name: 'bike4mind',
  branch: 'main',
  workspace: true,
  workingDirectory: '/Users/jude/Javascript/bike4mind/main',
  contextDirectories: ['/Users/jude/Javascript/shared-notes'],
};

describe('a new session in a project the user already has one in', () => {
  it('carries the folder, which is the whole point of starting it from there', () => {
    expect(newSessionInProject(SIBLING).directory).toBe(SIBLING.directory);
  });

  /**
   * The regression this module exists for: the sibling's branch reached resolveWorkspace and
   * failed against a container whose folder for that branch was holding another one, on a
   * click where the user had chosen no branch at all.
   */
  it('carries no branch and no worktree, so nothing is resolved that nobody asked for', () => {
    const request = newSessionInProject(SIBLING);

    expect(request.branch).toBeUndefined();
    expect(request.workspace).toBeUndefined();
  });

  it('carries no context directories, because those are grants made for another conversation', () => {
    expect(newSessionInProject(SIBLING).contextDirectories).toBeUndefined();
  });
});

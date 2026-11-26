// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation, type ProjectBindingController } from './useChat';
import { setWorktreeByDefault } from './worktreeDefault';
import type { ChatProject } from '@shared/chat';
import { newSessionInProject } from './newSessionInProject';
import { chatBackedHostBridge } from '../__fixtures__/chatBackedHostBridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('projectPicker', () => {
  const SESSION = 's1';
  const PROJECT = {
    directory: '/work/app/main',
    name: 'app',
    branch: 'main',
    workspace: true,
    workingDirectory: '/work/app/main',
    contextDirectories: [],
  };

  describe('cancelling the folder picker', () => {
    let container: HTMLDivElement;
    let root: Root;
    let binding: ProjectBindingController;
    let session: { project: unknown } | null;
    const updateProject = vi.fn();
    const inspectProject = vi.fn();
    const addContextDirectory = vi.fn();
    const pickProjectDirectory = vi.fn<() => Promise<string | null>>(async () => null);

    function Harness() {
      const conversation = useConversation(SESSION, () => undefined);
      binding = conversation.project;
      session = conversation.session as { project: unknown } | null;
      return null;
    }

    beforeEach(async () => {
      updateProject.mockReset();
      inspectProject.mockReset();
      addContextDirectory.mockReset();
      pickProjectDirectory.mockReset();
      pickProjectDirectory.mockResolvedValue(null);
      setWorktreeByDefault(false);
      vi.stubGlobal('requestAnimationFrame', () => 0);
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
      (window as unknown as { b4m: unknown }).b4m = {
        host: chatBackedHostBridge(),
        chat: {
          getSession: async () => ({ id: SESSION, messages: [], project: PROJECT }),
          getQueuedMessages: async () => [],
          onSessionSummary: () => () => undefined,
          onQueueChanged: () => () => undefined,
          onStreamEvent: () => () => undefined,
          pickProjectDirectory,
          updateProject,
          inspectProject,
          addContextDirectory,
        },
      };
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<Harness />));
      await act(async () => undefined);
    });

    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      setWorktreeByDefault(false);
      vi.unstubAllGlobals();
    });

    it('starts the newly picked folder in a worktree when the user wants that by default', async () => {
      setWorktreeByDefault(true);
      pickProjectDirectory.mockResolvedValue('/other');
      inspectProject.mockResolvedValue({
        directory: '/other',
        isRepository: true,
        branches: ['main'],
        currentBranch: 'main',
      });
      updateProject.mockResolvedValue({ ok: true, session: PROJECT });

      await act(async () => binding.pickDirectory());

      expect(updateProject).toHaveBeenCalledWith(
        expect.objectContaining({ directory: '/other', branch: 'main', workspace: true })
      );
    });

    it('leaves the worktree off by default', async () => {
      pickProjectDirectory.mockResolvedValue('/other');
      inspectProject.mockResolvedValue({
        directory: '/other',
        isRepository: true,
        branches: ['main'],
        currentBranch: 'main',
      });
      updateProject.mockResolvedValue({ ok: true, session: PROJECT });

      await act(async () => binding.pickDirectory());

      expect(inspectProject).toHaveBeenCalledWith('/other');
      expect(updateProject).toHaveBeenCalledWith({
        sessionId: SESSION,
        directory: '/other',
        branch: 'main',
        workspace: false,
      });
    });

    it('leaves the worktree off for a folder that cannot hold one', async () => {
      setWorktreeByDefault(true);
      pickProjectDirectory.mockResolvedValue('/plain');
      inspectProject.mockResolvedValue({ directory: '/plain', isRepository: false, branches: [], currentBranch: null });
      updateProject.mockResolvedValue({ ok: true, session: PROJECT });

      await act(async () => binding.pickDirectory());

      expect(updateProject).toHaveBeenCalledWith(expect.objectContaining({ directory: '/plain', workspace: false }));
    });

    it('leaves the project untouched and shows no notice', async () => {
      await act(async () => binding.pickDirectory());

      expect(updateProject).not.toHaveBeenCalled();
      expect(inspectProject).not.toHaveBeenCalled();
      expect(binding.error).toBeNull();
      expect(session?.project).toEqual(PROJECT);
    });

    it('shows no notice when the context-folder picker is dismissed', async () => {
      addContextDirectory.mockResolvedValue({ status: 'cancelled' });
      await act(async () => binding.addContextDirectory());

      expect(binding.error).toBeNull();
    });

    it('clears an earlier failure notice when the picker is opened again', async () => {
      updateProject.mockResolvedValue({ ok: false, error: 'boom' });
      await act(async () => binding.setBranch('other'));
      expect(binding.error?.message).toBe('boom');

      await act(async () => binding.pickDirectory());
      expect(binding.error).toBeNull();
    });
  });
});

describe('newSessionInProject', () => {
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

    /** The user's default, not the sibling's toggle - and still no branch, so main picks the base. */
    it('asks for a worktree when the user wants one by default', () => {
      const request = newSessionInProject({ ...SIBLING, workspace: false }, true);

      expect(request.workspace).toBe(true);
      expect(request.branch).toBeUndefined();
    });
  });
});

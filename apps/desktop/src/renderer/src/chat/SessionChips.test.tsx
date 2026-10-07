// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatProject, ProjectInspection } from '@shared/chat';
import { SessionChips } from './SessionChips';
import type { ProjectBindingController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONTAINER = '/Users/someone/code/thing';
const CHECKOUT = `${CONTAINER}/main`;
const WORKTREE = `${CONTAINER}/feat+chips`;

function project(over: Partial<ChatProject> = {}): ChatProject {
  return {
    directory: CHECKOUT,
    name: 'thing',
    branch: 'main',
    workspace: false,
    workingDirectory: CHECKOUT,
    contextDirectories: [],
    ...over,
  };
}

function inspection(over: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    directory: CHECKOUT,
    name: 'thing',
    isRepository: true,
    branches: ['main', 'feat/chips'],
    currentBranch: 'main',
    ...over,
  };
}

const binding: ProjectBindingController = {
  busy: false,
  error: null,
  dismissError: vi.fn(),
  pickDirectory: vi.fn(),
  setBranch: vi.fn(),
  setWorkspace: vi.fn(),
  addContextDirectory: vi.fn(),
  removeContextDirectory: vi.fn(),
};

describe('the branch chip against what git answers', () => {
  let host: HTMLDivElement;
  let root: Root;
  const inspectProject = vi.fn();

  async function show(bound: ChatProject, settledTurns = 0): Promise<void> {
    await act(async () => root.render(<SessionChips project={bound} binding={binding} settledTurns={settledTurns} />));
    await act(async () => undefined);
  }

  const label = (): string | undefined =>
    host.querySelector('[data-testid="session-chip-branch-btn"]')?.textContent ?? undefined;

  beforeEach(() => {
    inspectProject.mockReset();
    (window as unknown as { b4m: unknown }).b4m = { chat: { inspectProject } };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('names the branch an ordinary checkout is on', async () => {
    inspectProject.mockResolvedValue(inspection());
    await show(project());

    expect(label()).toBe('main');
  });

  /**
   * The report this file exists for: the folder is a checkout that has since been moved onto
   * another branch, and the chip used to answer with the branch the session RECORDED.
   */
  it('names the branch the folder is really on, not the one the session recorded', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'fix/scrub-missing-knowledge-ids' }));
    await show(project({ branch: 'main' }));

    expect(label()).toBe('fix/scrub-missing-knowledge-ids');
  });

  it('reads HEAD from the worktree once the session runs in one', async () => {
    inspectProject.mockImplementation(async (directory: string) =>
      directory === WORKTREE
        ? inspection({ directory: WORKTREE, currentBranch: 'feat/chips' })
        : inspection({ currentBranch: 'main' })
    );
    await show(project({ branch: 'feat/chips', workspace: true, workingDirectory: WORKTREE }));

    expect(label()).toBe('feat/chips');
  });

  it('admits a detached HEAD rather than naming the recorded branch', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: null }));
    await show(project({ branch: 'main' }));

    expect(label()).toBe('no branch');
  });

  /**
   * A worktree container answers git for the BARE repo and is refused as a project, so the one
   * way a session is still bound to one is from before that refusal existed. It must not then
   * put up the recorded branch as though something had checked it out.
   */
  it('names no branch for a folder git reports as no repository', async () => {
    inspectProject.mockResolvedValue(
      inspection({ directory: CONTAINER, isRepository: false, branches: [], currentBranch: null })
    );
    await show(project({ directory: CONTAINER, workingDirectory: CONTAINER, branch: 'main' }));

    expect(label()).toBe('no branch');
  });

  it('says in the menu that picking a branch checks nothing out while the toggle is off', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'fix/elsewhere' }));
    await show(project());

    await act(async () => {
      (host.querySelector('[data-testid="session-chip-branch-btn"]') as HTMLElement).click();
    });
    const notice = document.body.querySelector('[data-testid="session-chip-branch-notice"]')?.textContent ?? '';
    expect(notice).toMatch(/nothing is checked out/i);
    expect(notice).toContain('fix/elsewhere');
  });

  /** HEAD moves from a terminal, and the chip is read after the user comes back to the window. */
  it('re-reads HEAD when the window regains focus', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockResolvedValue(inspection({ currentBranch: 'feat/chips' }));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await act(async () => undefined);

    expect(label()).toBe('feat/chips');
  });

  /**
   * The case focus cannot catch: the agent's own `git switch` moves HEAD without the window
   * ever being blurred, so the reading has to be re-taken when the reply that ran it ends.
   */
  it('re-reads HEAD when a reply ends', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockResolvedValue(inspection({ currentBranch: 'feat/chips' }));
    await show(project(), 1);

    expect(label()).toBe('feat/chips');
  });

  /** A re-read is a trigger, not a poll: an idle chip asks git nothing after its first answer. */
  it('asks git nothing while nothing has happened', async () => {
    inspectProject.mockResolvedValue(inspection());
    await show(project());
    const asked = inspectProject.mock.calls.length;

    await show(project(), 0);
    await act(async () => undefined);

    expect(inspectProject.mock.calls.length).toBe(asked);
  });

  /**
   * Picking a branch with the toggle off checks nothing out, so a re-read must answer with the
   * branch the folder is still on - never with the one the session has just recorded.
   */
  it('keeps naming the checked-out branch when a re-read follows a recorded-only pick', async () => {
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project({ branch: 'main' }));

    await show(project({ branch: 'feat/chips' }), 1);

    expect(label()).toBe('main');
  });

  /**
   * The race the `of === key` guard exists for, now that a second trigger can start a read:
   * a reading begun before a move must not land on the folders it was not taken in.
   */
  it('drops a re-read that a later move has overtaken', async () => {
    let release: (value: ProjectInspection) => void = () => undefined;
    inspectProject.mockResolvedValue(inspection({ currentBranch: 'main' }));
    await show(project());
    expect(label()).toBe('main');

    inspectProject.mockImplementation(
      async () =>
        await new Promise<ProjectInspection>(resolve => {
          release = resolve;
        })
    );
    await act(async () => {
      root.render(<SessionChips project={project()} binding={binding} settledTurns={1} />);
    });

    inspectProject.mockResolvedValue(inspection({ directory: WORKTREE, currentBranch: 'feat/chips' }));
    await show(project({ branch: 'feat/chips', workspace: true, workingDirectory: WORKTREE }), 1);
    expect(label()).toBe('feat/chips');

    await act(async () => {
      release(inspection({ currentBranch: 'main' }));
    });

    expect(label()).toBe('feat/chips');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatProject } from '@shared/chat';
import type { WorkspaceChanges } from '@shared/workspaceChanges';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceChanges } from './useWorkspaceChanges';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT: ChatProject = {
  directory: '/repo',
  name: 'repo',
  branch: 'main',
  workspace: true,
  workspaceBranch: 'b4m/x-abc123',
  workingDirectory: '/repo/.b4m/worktrees/b4m+x-abc123',
  contextDirectories: [],
};

function changes(added: number): WorkspaceChanges {
  return { base: 'origin/main', added, removed: 0, fileCount: 1, files: [], commitsAhead: 0, uncommitted: 1 };
}

let seen: WorkspaceChanges | null = null;

function Harness({ sessionId, settledTurns }: { sessionId: string | null; settledTurns: number }) {
  seen = useWorkspaceChanges(sessionId, sessionId ? PROJECT : undefined, settledTurns);
  return null;
}

describe('useWorkspaceChanges', () => {
  let container: HTMLDivElement;
  let root: Root;
  const workspaceChanges = vi.fn<(sessionId: string) => Promise<WorkspaceChanges | null>>();

  beforeEach(() => {
    seen = null;
    workspaceChanges.mockReset();
    (window as unknown as { b4m: unknown }).b4m = { chat: { workspaceChanges } };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(sessionId: string | null, settledTurns = 0): Promise<void> {
    await act(async () => root.render(<Harness sessionId={sessionId} settledTurns={settledTurns} />));
  }

  it('reads for the open session and re-reads when a reply settles', async () => {
    workspaceChanges.mockResolvedValueOnce(changes(3)).mockResolvedValueOnce(changes(7));

    await render('s1', 0);
    expect(seen).toMatchObject({ added: 3 });

    await render('s1', 1);
    expect(workspaceChanges).toHaveBeenCalledTimes(2);
    expect(seen).toMatchObject({ added: 7 });
  });

  it('re-reads on window focus, when the user may have committed in a terminal', async () => {
    workspaceChanges.mockResolvedValueOnce(changes(3)).mockResolvedValueOnce(null);
    await render('s1');

    await act(async () => window.dispatchEvent(new Event('focus')));

    expect(workspaceChanges).toHaveBeenCalledTimes(2);
    expect(seen).toBeNull();
  });

  it("never shows one session's reading under another while the new one is pending", async () => {
    workspaceChanges.mockResolvedValueOnce(changes(3)).mockReturnValueOnce(new Promise(() => undefined));
    await render('s1');
    expect(seen).toMatchObject({ added: 3 });

    await render('s2');

    expect(workspaceChanges).toHaveBeenLastCalledWith('s2');
    expect(seen).toBeNull();
  });

  it('asks nothing with no session open', async () => {
    await render(null);
    expect(workspaceChanges).not.toHaveBeenCalled();
    expect(seen).toBeNull();
  });
});

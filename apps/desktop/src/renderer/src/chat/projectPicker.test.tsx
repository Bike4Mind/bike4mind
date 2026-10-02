// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation, type ProjectBindingController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        getSession: async () => ({ id: SESSION, messages: [], project: PROJECT }),
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => undefined,
        onQueueChanged: () => () => undefined,
        onStreamEvent: () => () => undefined,
        pickProjectDirectory: async () => null,
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
    vi.unstubAllGlobals();
  });

  it('leaves the project untouched and shows no notice', async () => {
    await act(async () => binding.pickDirectory());

    expect(updateProject).not.toHaveBeenCalled();
    expect(inspectProject).not.toHaveBeenCalled();
    expect(binding.error).toBeNull();
    expect(session?.project).toEqual(PROJECT);
  });

  it('shows no notice when the context-folder picker is dismissed', async () => {
    addContextDirectory.mockResolvedValue(null);
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

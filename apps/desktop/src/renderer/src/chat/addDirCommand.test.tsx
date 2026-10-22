// @vitest-environment jsdom
import type { ShareDirectoryResult } from '@shared/directoryRequest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversation, type ConversationController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = 's1';
const PROJECT = {
  directory: '/work/app/main',
  name: 'app',
  branch: 'main',
  workspace: true,
  workingDirectory: '/work/app/main',
  contextDirectories: [] as string[],
};

/** `/add-dir` and the chip's button reach main through the one share; this is what each answer shows. */
describe('/add-dir', () => {
  let container: HTMLDivElement;
  let root: Root;
  let conversation: ConversationController;
  const addContextDirectory = vi.fn<(sessionId: string, path?: string) => Promise<ShareDirectoryResult>>();

  function Harness() {
    conversation = useConversation(SESSION, () => undefined);
    return null;
  }

  beforeEach(async () => {
    addContextDirectory.mockReset();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    (window as unknown as { b4m: unknown }).b4m = {
      chat: {
        getSession: async () => ({ id: SESSION, mode: 'code', messages: [], project: PROJECT }),
        getQueuedMessages: async () => [],
        onSessionSummary: () => () => undefined,
        onQueueChanged: () => () => undefined,
        onStreamEvent: () => () => undefined,
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

  const run = (args: string) => act(async () => conversation.runCommand('add-dir', args));

  it('shares the path it was given and says so', async () => {
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: '/work/shared',
      session: { id: SESSION, project: { ...PROJECT, contextDirectories: ['/work/shared'] } } as never,
    });
    await run('"~/shared"');

    expect(addContextDirectory).toHaveBeenCalledWith(SESSION, '~/shared');
    expect(conversation.notice).toBe('Shared /work/shared with this conversation.');
    expect(conversation.sendError).toBeNull();
    expect(conversation.session?.project?.contextDirectories).toEqual(['/work/shared']);
  });

  it('opens the picker when run bare, and a dismissed picker says nothing', async () => {
    addContextDirectory.mockResolvedValue({ status: 'cancelled' });
    await run('');

    expect(addContextDirectory).toHaveBeenCalledWith(SESSION, undefined);
    expect(conversation.notice).toBeNull();
    expect(conversation.sendError).toBeNull();
  });

  it.each([
    ['a missing path', '/work/missing is not an existing folder, so it cannot be shared.'],
    ['a file', '/work/file.txt is not an existing folder, so it cannot be shared.'],
  ])('shows main refusing %s', async (_name, error) => {
    addContextDirectory.mockResolvedValue({ status: 'refused', error });
    await run('/work/x');

    expect(conversation.sendError).toBe(error);
    expect(conversation.notice).toBeNull();
  });

  it('notes a folder that is already shared without changing anything', async () => {
    addContextDirectory.mockResolvedValue({ status: 'already', path: '/work/app/main' });
    await run('.');

    expect(conversation.notice).toBe('/work/app/main is already shared with this conversation.');
    expect(conversation.session?.project?.contextDirectories).toEqual([]);
  });

  it('confirms nothing for the chip button, whose new chip is the confirmation', async () => {
    addContextDirectory.mockResolvedValue({
      status: 'added',
      path: '/work/shared',
      session: { id: SESSION, project: { ...PROJECT, contextDirectories: ['/work/shared'] } } as never,
    });
    await act(async () => conversation.project.addContextDirectory());

    expect(addContextDirectory).toHaveBeenCalledWith(SESSION, undefined);
    expect(conversation.notice).toBeNull();
    expect(conversation.session?.project?.contextDirectories).toEqual(['/work/shared']);
  });
});

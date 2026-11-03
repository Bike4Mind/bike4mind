// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreationTool } from '@shared/chat';
import { resetCreationToolsCache, useCreationTools } from './useCreationTools';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMAGE: CreationTool[] = [{ name: 'generate_image' }];
const VIDEO: CreationTool[] = [{ name: 'generate_video' }];

function deferredTools() {
  let resolve: (tools: CreationTool[]) => void = () => {
    throw new Error('Promise not initialized');
  };
  const promise = new Promise<CreationTool[]>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('useCreationTools', () => {
  let root: Root;
  let container: HTMLElement;
  let tools: CreationTool[] | null;
  const listCreationTools = vi.fn<(model: string) => Promise<CreationTool[]>>();

  function Probe({ account, sessionId, model }: { account: string; sessionId: string | null; model: string }) {
    tools = useCreationTools(account, sessionId, model);
    return null;
  }

  const render = (account = 'account-1', sessionId: string | null = 'session-1', model = 'hosted-model') =>
    act(async () => root.render(<Probe account={account} sessionId={sessionId} model={model} />));

  beforeEach(() => {
    resetCreationToolsCache();
    listCreationTools.mockReset();
    tools = null;
    (window as unknown as { b4m: unknown }).b4m = { chat: { listCreationTools } };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('waits for the new model rather than offering the previous model tools', async () => {
    listCreationTools.mockResolvedValueOnce(IMAGE);
    await render();
    expect(tools).toEqual(IMAGE);

    const next = deferredTools();
    listCreationTools.mockReturnValueOnce(next.promise);
    await render('account-1', 'session-1', 'other-hosted-model');
    expect(tools).toBeNull();

    await act(async () => next.resolve([]));
    expect(tools).toEqual([]);
    expect(listCreationTools).toHaveBeenLastCalledWith('other-hosted-model');
  });

  it('keeps account caches separate across a remount', async () => {
    listCreationTools.mockResolvedValueOnce(VIDEO);
    await render();
    act(() => root.unmount());
    root = createRoot(container);

    const next = deferredTools();
    listCreationTools.mockReturnValueOnce(next.promise);
    await render('account-2');
    expect(tools).toBeNull();
    await act(async () => next.resolve([]));
    expect(tools).toEqual([]);
  });

  it('retains a same-model answer while refreshing on another blank session', async () => {
    listCreationTools.mockResolvedValueOnce(IMAGE);
    await render();

    const next = deferredTools();
    listCreationTools.mockReturnValueOnce(next.promise);
    await render('account-1', 'session-2');
    expect(tools).toEqual(IMAGE);
    expect(listCreationTools).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve(VIDEO));
    expect(tools).toEqual(VIDEO);
  });

  it('does not let an abandoned request overwrite a newer cached answer', async () => {
    const old = deferredTools();
    listCreationTools.mockReturnValueOnce(old.promise).mockResolvedValueOnce(VIDEO);
    await render();
    await render('account-1', 'session-2');
    expect(tools).toEqual(VIDEO);
    await act(async () => old.resolve(IMAGE));

    const next = deferredTools();
    listCreationTools.mockReturnValueOnce(next.promise);
    await render('account-1', 'session-3');
    expect(tools).toEqual(VIDEO);
    await act(async () => next.resolve(VIDEO));
  });

  it('logs a failed initial read and allows the text cards, then retries on the next opening', async () => {
    const error = new Error('IPC unavailable');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listCreationTools.mockRejectedValueOnce(error).mockResolvedValueOnce(IMAGE);
    await render();
    expect(tools).toEqual([]);
    expect(warning).toHaveBeenCalledWith('Could not load creation tools', error);

    await render('account-1', 'session-2');
    expect(tools).toEqual(IMAGE);
    expect(listCreationTools).toHaveBeenCalledTimes(2);
  });

  it('does not ask for hidden blank chats or local models', async () => {
    await render('account-1', null);
    expect(listCreationTools).not.toHaveBeenCalled();
    await render('account-1', 'session-1', 'local:ollama:qwen3:8b');
    expect(tools).toEqual([]);
    expect(listCreationTools).not.toHaveBeenCalled();
  });

  it('clears cached media cards when the current refresh fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    listCreationTools.mockResolvedValueOnce(VIDEO).mockRejectedValueOnce(new Error('IPC unavailable'));
    await render();
    expect(tools).toEqual(VIDEO);
    await render('account-1', 'session-2');
    expect(tools).toEqual([]);
  });
});

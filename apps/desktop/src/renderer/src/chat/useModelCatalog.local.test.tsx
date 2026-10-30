// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatModelCatalog, ChatModelOption } from '@shared/chat';
import type { ModelRuntimeStatus } from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_STATUS_POLL_MS, useModelCatalog, type ModelCatalogController } from './useChat';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const model: ChatModelOption = { id: 'local:ollama:qwen', name: 'qwen' };
const status = (reachable: boolean): ModelRuntimeStatus => ({
  reachable,
  version: reachable ? '0.9.0' : null,
  url: 'http://127.0.0.1:11434',
  error: null,
  serverId: 'local',
  serverName: 'This computer',
  management: 'allowed',
});

const listModels = vi.fn<(force?: boolean) => Promise<ChatModelCatalog>>();
const getStatus = vi.fn<() => Promise<ModelRuntimeStatus>>();
let authListeners: Array<(state: unknown) => void> = [];
let installedListeners: Array<() => void> = [];
let root: Root;
let host: HTMLElement;
let catalog: ModelCatalogController;

function Harness({ local }: { local: boolean }) {
  catalog = useModelCatalog(local);
  return null;
}

async function mount(local = true) {
  await act(async () => root.render(<Harness local={local} />));
}
async function tick(ms = LOCAL_STATUS_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  listModels.mockReset();
  getStatus.mockReset();
  authListeners = [];
  installedListeners = [];
  listModels.mockResolvedValue({ models: [] });
  getStatus.mockResolvedValue(status(false));
  Object.assign(window, {
    b4m: {
      chat: { listModels },
      models: {
        getStatus,
        onInstalledChanged: (listener: () => void) => {
          installedListeners.push(listener);
          return () => (installedListeners = installedListeners.filter(item => item !== listener));
        },
      },
      auth: {
        onStateChanged: (listener: (state: unknown) => void) => {
          authListeners.push(listener);
          return () => (authListeners = authListeners.filter(item => item !== listener));
        },
      },
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

describe('useModelCatalog in local mode', () => {
  it('notices Ollama coming back within one poll and loads the list', async () => {
    await mount();
    expect(catalog.runtime?.reachable).toBe(false);
    getStatus.mockResolvedValue(status(true));
    listModels.mockResolvedValue({ models: [model] });
    await tick();
    expect(catalog.models).toEqual([model]);
    expect(catalog.runtime?.reachable).toBe(true);
  });

  it('notices Ollama stopping while models are listed', async () => {
    getStatus.mockResolvedValue(status(true));
    listModels.mockResolvedValue({ models: [model] });
    await mount();
    expect(catalog.runtime?.reachable).toBe(true);

    getStatus.mockResolvedValue(status(false));
    listModels.mockResolvedValue({ models: [] });
    await tick();
    expect(catalog.runtime?.reachable).toBe(false);
    expect(catalog.models).toEqual([]);
  });

  it('makes only the cheap status call while nothing changed and models are listed', async () => {
    getStatus.mockResolvedValue(status(true));
    listModels.mockResolvedValue({ models: [model] });
    await mount();
    listModels.mockClear();
    await tick(LOCAL_STATUS_POLL_MS * 3);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('skips polling while the window is hidden and checks again when it is shown', async () => {
    await mount();
    getStatus.mockClear();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await tick(LOCAL_STATUS_POLL_MS * 2);
    expect(getStatus).not.toHaveBeenCalled();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    getStatus.mockResolvedValue(status(true));
    listModels.mockResolvedValue({ models: [model] });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(catalog.models).toEqual([model]);
  });

  it('checks on window focus and removes its listeners and timer on unmount', async () => {
    await mount();
    getStatus.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(getStatus).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<Harness local={false} />));
    getStatus.mockClear();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await tick(LOCAL_STATUS_POLL_MS * 2);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it('does not poll when signed in', async () => {
    await mount(false);
    getStatus.mockClear();
    await tick(LOCAL_STATUS_POLL_MS * 2);
    expect(getStatus).not.toHaveBeenCalled();
    expect(catalog.runtime).toBeNull();
  });

  it('drops a slower, older response that finishes after a newer one', async () => {
    const slow = deferred<ChatModelCatalog>();
    listModels.mockReturnValueOnce(slow.promise);
    await mount();
    listModels.mockResolvedValue({ models: [model] });
    await act(async () => {
      await catalog.reload();
    });
    expect(catalog.models).toEqual([model]);
    await act(async () => slow.resolve({ models: [] }));
    expect(catalog.models).toEqual([model]);
  });
});

describe('useModelCatalog when a model finishes installing', () => {
  it.each([true, false])('rereads the list and shows the new model (local=%s)', async local => {
    await mount(local);
    expect(catalog.models).toEqual([]);
    expect(installedListeners).toHaveLength(1);
    listModels.mockClear();
    listModels.mockResolvedValue({ models: [model] });
    await act(async () => installedListeners.forEach(listener => listener()));
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModels).toHaveBeenCalledWith(true);
    expect(catalog.models).toEqual([model]);
  });

  it('stops listening on unmount', async () => {
    await mount(false);
    expect(installedListeners).toHaveLength(1);
    await act(async () => root.render(null));
    expect(installedListeners).toHaveLength(0);
  });
});

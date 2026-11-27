import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEW_SNAPSHOT_CONTRACT } from '@shared/viewSnapshot';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ORCHESTRATE_MINI_PREFERENCES,
  OrchestrateMiniPreferencesStore,
  parseOrchestrateMiniPreferences,
} from './preferences';
import type { OrchestrateMiniPayload } from '@shared/orchestrateMini';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => electron.handlers.set(channel, handler),
  },
}));

const { IPC_CHANNELS } = await import('@shared/ipc');
const { focusTarget, registerOrchestrateMiniIpc } = await import('./ipc');

const appWindow = { id: 'app' };
const miniWindow = { id: 'mini' };
const stranger = { id: 'other' };

const agent = (id: string, state: 'needs-you' | 'working') => ({
  id,
  title: id,
  state,
  parentId: 'root',
  depth: 1,
  updatedAt: '2026-11-01',
});

const payload = (rootState: 'needs-you' | 'working' = 'working'): OrchestrateMiniPayload => ({
  snapshot: {
    contract: VIEW_SNAPSHOT_CONTRACT,
    root: { id: 'root', state: rootState },
    agents: [agent('asking', 'needs-you'), agent('busy', 'working')],
  },
  presenting: false,
  skin: { id: null, states: {}, surfaces: {} },
});

function setup(current: OrchestrateMiniPayload | null = payload()) {
  electron.handlers.clear();
  const deps = {
    isAppWindow: (sender: unknown) => sender === appWindow,
    isMiniWindow: (sender: unknown) => sender === miniWindow,
    current: vi.fn(() => current),
    publish: vi.fn(),
    isOpen: vi.fn(() => true),
    toggle: vi.fn(),
    close: vi.fn(),
    openSession: vi.fn(),
  };
  registerOrchestrateMiniIpc(deps as unknown as Parameters<typeof registerOrchestrateMiniIpc>[0]);
  const call = (channel: string, sender: unknown, ...args: unknown[]) => {
    const handler = electron.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({ sender }, ...args);
  };
  return { deps, call };
}

describe('focusTarget', () => {
  it('opens an agent that waits on a decision, under its root', () => {
    expect(focusTarget(payload(), 'asking')).toEqual({ sessionId: 'asking', rootId: 'root' });
  });

  it('opens the root only while it waits on you itself', () => {
    expect(focusTarget(payload('needs-you'), 'root')).toEqual({ sessionId: 'root', rootId: 'root' });
    expect(focusTarget(payload('working'), 'root')).toBeNull();
  });

  it('goes nowhere for an agent that is not waiting, an unknown id, or no payload', () => {
    expect(focusTarget(payload(), 'busy')).toBeNull();
    expect(focusTarget(payload(), 'elsewhere')).toBeNull();
    expect(focusTarget(payload(), 42)).toBeNull();
    expect(focusTarget(null, 'asking')).toBeNull();
  });
});

describe('registerOrchestrateMiniIpc', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));

  it('takes a valid payload, or null, from an app window', () => {
    const { deps, call } = setup();
    call(IPC_CHANNELS.orchestrateMiniPublish, appWindow, payload());
    call(IPC_CHANNELS.orchestrateMiniPublish, appWindow, null);
    expect(deps.publish.mock.calls).toEqual([
      [payload(), appWindow],
      [null, appWindow],
    ]);
  });

  it('drops a malformed payload and anything published from outside an app window', () => {
    const { deps, call } = setup();
    call(IPC_CHANNELS.orchestrateMiniPublish, appWindow, { ...payload(), transcript: 'x' });
    call(IPC_CHANNELS.orchestrateMiniPublish, miniWindow, payload());
    call(IPC_CHANNELS.orchestrateMiniPublish, stranger, payload());
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('drops a payload that arrives after the window closed, but still takes a clear', () => {
    const { deps, call } = setup();
    deps.isOpen.mockReturnValue(false);
    call(IPC_CHANNELS.orchestrateMiniPublish, appWindow, payload());
    call(IPC_CHANNELS.orchestrateMiniPublish, appWindow, null);
    expect(deps.publish.mock.calls).toEqual([[null, appWindow]]);
  });

  it('serves the payload to the mini window only', () => {
    const { call } = setup();
    expect(call(IPC_CHANNELS.orchestrateMiniGetSnapshot, miniWindow)).toEqual(payload());
    expect(call(IPC_CHANNELS.orchestrateMiniGetSnapshot, appWindow)).toBeNull();
    expect(call(IPC_CHANNELS.orchestrateMiniGetSnapshot, stranger)).toBeNull();
  });

  it('raises the app on a waiting decision from the mini window, and on nothing else', () => {
    const { deps, call } = setup();
    call(IPC_CHANNELS.orchestrateMiniFocus, miniWindow, 'busy');
    call(IPC_CHANNELS.orchestrateMiniFocus, stranger, 'asking');
    call(IPC_CHANNELS.orchestrateMiniFocus, appWindow, 'asking');
    expect(deps.openSession).not.toHaveBeenCalled();

    call(IPC_CHANNELS.orchestrateMiniFocus, miniWindow, 'asking');
    expect(deps.openSession).toHaveBeenCalledWith({ sessionId: 'asking', rootId: 'root' });
  });

  it('toggles for an app window, closes for the mini window, and ignores everyone else', () => {
    const { deps, call } = setup();
    call(IPC_CHANNELS.orchestrateMiniToggle, stranger);
    call(IPC_CHANNELS.orchestrateMiniClose, appWindow);
    expect(deps.toggle).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();

    expect(call(IPC_CHANNELS.orchestrateMiniToggle, appWindow)).toBe(true);
    call(IPC_CHANNELS.orchestrateMiniClose, miniWindow);
    expect(deps.toggle).toHaveBeenCalledTimes(1);
    expect(deps.close).toHaveBeenCalledTimes(1);
  });
});

describe('preferences', () => {
  describe('parseOrchestrateMiniPreferences', () => {
    it('is off with no bounds by default', () => {
      expect(parseOrchestrateMiniPreferences(undefined)).toEqual(DEFAULT_ORCHESTRATE_MINI_PREFERENCES);
      expect(DEFAULT_ORCHESTRATE_MINI_PREFERENCES.open).toBe(false);
    });

    it('keeps a good field when the other is bad', () => {
      expect(parseOrchestrateMiniPreferences({ open: true, bounds: { x: 'left' } })).toEqual({
        open: true,
        bounds: null,
      });
      expect(parseOrchestrateMiniPreferences({ open: 'yes', bounds: { x: 1, y: 2, width: 3, height: 4 } })).toEqual({
        open: false,
        bounds: { x: 1, y: 2, width: 3, height: 4 },
      });
    });
  });

  describe('OrchestrateMiniPreferencesStore', () => {
    it('round-trips its bounds and visibility through the file', async () => {
      const path = join(await mkdtemp(join(tmpdir(), 'orchestrate-mini-')), 'orchestrate-mini.json');
      const store = new OrchestrateMiniPreferencesStore(path);
      await store.load();
      await store.update({ open: true });
      await store.update({ bounds: { x: 10, y: 20, width: 300, height: 340 } });

      const reloaded = new OrchestrateMiniPreferencesStore(path);
      expect(await reloaded.load()).toEqual({ open: true, bounds: { x: 10, y: 20, width: 300, height: 340 } });
    });

    it('starts from the defaults when the file is not JSON', async () => {
      const path = join(await mkdtemp(join(tmpdir(), 'orchestrate-mini-')), 'orchestrate-mini.json');
      await writeFile(path, '{ not json');
      const store = new OrchestrateMiniPreferencesStore(path);
      expect(await store.load()).toEqual(DEFAULT_ORCHESTRATE_MINI_PREFERENCES);
      expect(await readFile(path, 'utf8')).toBe('{ not json');
    });
  });
});

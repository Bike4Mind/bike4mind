// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledModelsResult, LocalModelEntry, ModelPull, ModelRuntimeStatus } from '@shared/models';
import type { ModelServerView } from '@shared/modelServers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstalledCache, installedCache, listedAtLabel, serverIdentity } from './installedCache';
import { DOWN_RECHECK_MS, useModelHub, useModelServers, type ModelHubState } from './useModelHub';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function model(name: string): LocalModelEntry {
  return {
    name,
    sizeBytes: 1,
    quantization: null,
    family: null,
    parameterSize: null,
    modifiedAt: null,
    capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
    loaded: false,
    fit: null,
  };
}

function view(id: string, extra: Partial<ModelServerView> = {}): ModelServerView {
  return {
    id,
    name: id,
    local: false,
    kind: 'ollama',
    transport: 'http',
    address: `http://${id}:11434`,
    access: 'manage',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: true,
    health: { state: 'online', version: null, latencyMs: null, checkedAt: null, error: null },
    models: [],
    specs: null,
    launch: null,
    ...extra,
  };
}

describe('listedAtLabel', () => {
  const noon = new Date(2026, 10, 2, 12, 0).getTime();

  it('gives only the time for a listing from today', () => {
    const at = new Date(2026, 10, 2, 9, 30).getTime();
    expect(listedAtLabel(at, noon)).toBe(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });

  it('adds the date for a listing from another day', () => {
    const at = new Date(2026, 10, 1, 23, 50).getTime();
    const label = listedAtLabel(at, noon);
    expect(label).toContain(new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }));
    expect(label).toContain(new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  });
});

describe('InstalledCache', () => {
  const gpu = view('gpu');
  const lab = view('lab');

  it('returns the last listing for the same server and identity', () => {
    const cache = new InstalledCache();
    expect(cache.get('gpu', serverIdentity(gpu))).toBeNull();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    expect(cache.get('gpu', serverIdentity(gpu))).toEqual({ models: [model('a')], listedAt: 1_000 });
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
  });

  it('replaces an entry with the newer listing', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    cache.set('gpu', serverIdentity(gpu), [model('a'), model('b')], 2_000);
    expect(cache.get('gpu', serverIdentity(gpu))?.models.map(entry => entry.name)).toEqual(['a', 'b']);
    expect(cache.get('gpu', serverIdentity(gpu))?.listedAt).toBe(2_000);
  });

  it('misses without an identity, or when the address or kind changed', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    expect(cache.get('gpu', null)).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, address: 'http://other:11434' }))).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, kind: 'openai-compatible' }))).toBeNull();
    expect(cache.get('gpu', serverIdentity({ ...gpu, transport: 'ssh' }))).toBeNull();
  });

  it('drops removed servers and servers saved at another address, and keeps the rest', () => {
    const cache = new InstalledCache();
    cache.set('gpu', serverIdentity(gpu), [model('a')], 1_000);
    cache.set('lab', serverIdentity(lab), [model('b')], 1_000);
    const shared = view('shared');
    cache.set('shared', serverIdentity(shared), [model('c')], 1_000);

    cache.retain([
      { ...gpu, name: 'renamed', access: 'chat' },
      { ...shared, address: 'http://moved:11434' },
    ]);

    expect(cache.get('gpu', serverIdentity(gpu))?.models).toEqual([model('a')]);
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
    expect(cache.get('shared', serverIdentity(shared))).toBeNull();
    // A server saved back at its old address does not get the dropped entry back.
    cache.retain([gpu, lab, shared]);
    expect(cache.get('lab', serverIdentity(lab))).toBeNull();
  });
});

const GPU = view('gpu');
const GPU_ID = serverIdentity(GPU);
const qwen = model('qwen2.5:0.5b');
const llama = model('llama3.2:3b');

const up = (serverId: string): ModelRuntimeStatus => ({
  reachable: true,
  version: '0.40.11',
  url: `http://${serverId}:11434`,
  error: null,
  serverId,
  serverName: serverId,
  management: 'allowed',
});
const down = (serverId: string): ModelRuntimeStatus => ({ ...up(serverId), reachable: false, error: 'refused' });

function failedPull(serverId: string, phase: 'failed' | 'paused' = 'failed', key = `${serverId}/repo#q`): ModelPull {
  return {
    key,
    serverId,
    serverName: serverId,
    repo: 'repo',
    buildId: 'q',
    label: 'Q4_K_M',
    ref: null,
    phase,
    completedBytes: 0,
    totalBytes: null,
    expectedBytes: 1,
    error: { kind: 'connection-lost', message: 'Lost the connection.' },
  };
}

let statuses: Record<string, ModelRuntimeStatus>;
let listings: Record<string, InstalledModelsResult>;
/** Holds the next listing, as read when asked, until it settles. */
let listingGate: Promise<void> | undefined;
let pushPulls: (pulls: ModelPull[]) => void;
let pushInstalled: (serverId: string) => void;
let pushServers: (servers: ModelServerView[]) => void;
const getStatus = vi.fn();
const listInstalled = vi.fn();
let listServers: () => Promise<ModelServerView[]>;

beforeEach(() => {
  installedCache.clear();
  statuses = { gpu: up('gpu'), local: up('local'), shared: up('shared') };
  listings = { gpu: { ok: true, models: [qwen, llama] }, local: { ok: true, models: [] } };
  listingGate = undefined;
  getStatus.mockReset();
  listInstalled.mockReset();
  listServers = async () => [GPU];
  (window as unknown as { b4m: unknown }).b4m = {
    models: {
      getStatus: async (serverId: string) => {
        getStatus(serverId);
        return statuses[serverId];
      },
      listInstalled: async (serverId: string) => {
        listInstalled(serverId);
        const answer = listings[serverId];
        const gate = listingGate;
        listingGate = undefined;
        await gate;
        return answer;
      },
      listPulls: async () => [],
      onPullsChanged: (listener: (pulls: ModelPull[]) => void) => {
        pushPulls = listener;
        return () => {};
      },
      onInstalledChanged: (listener: (serverId: string) => void) => {
        pushInstalled = listener;
        return () => {};
      },
    },
    modelServers: {
      list: () => listServers(),
      onChanged: (listener: (servers: ModelServerView[]) => void) => {
        pushServers = listener;
        return () => {};
      },
    },
  };
});

let root: Root | null = null;
let hub: ModelHubState;
let servers: ModelServerView[] | null;

function Probe({ serverId, identity }: { serverId: string; identity: string | null }) {
  hub = useModelHub(serverId, identity);
  return null;
}

function ServersProbe() {
  servers = useModelServers();
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

const { setImmediate: realSetImmediate } = globalThis as unknown as { setImmediate: (callback: () => void) => void };
const flush = () => act(async () => new Promise<void>(resolve => realSetImmediate(resolve)));

async function show(serverId: string, identity: string | null) {
  root ??= createRoot(document.createElement('div'));
  act(() => root?.render(<Probe serverId={serverId} identity={identity} />));
  await flush();
}

function gateListing() {
  let release = () => {};
  listingGate = new Promise<void>(resolve => (release = resolve));
  return async () => {
    release();
    await flush();
  };
}

const cached = (serverId = 'gpu', identity = GPU_ID) =>
  installedCache.get(serverId, identity)?.models.map(entry => entry.name) ?? null;

describe('useModelHub', () => {
  it('caches a listing only while the screen still shows the server it was started for', async () => {
    const release = gateListing();
    const local = serverIdentity(view('local'));
    await show('gpu', GPU_ID);
    await show('local', local);
    await release();
    expect(cached()).toBeNull();
    expect(cached('gpu', local)).toBeNull();
  });

  // A removal cuts listings of its server before and after the delete (InstalledTab), so a listing that was in
  // flight across it may still name the removed model.
  it.each([
    ['a listing', () => pushInstalled('gpu')],
    ['a check and listing', () => pushPulls([failedPull('gpu')])],
  ])('does not cache %s that started before a removal', async (_label, start) => {
    await show('gpu', GPU_ID);
    expect(cached()).toEqual(['qwen2.5:0.5b', 'llama3.2:3b']);
    const release = gateListing();
    const listed = listInstalled.mock.calls.length;
    act(start);
    await flush();
    expect(listInstalled).toHaveBeenCalledTimes(listed + 1);
    installedCache.cutListings('gpu');
    installedCache.dropModel('gpu', 'qwen2.5:0.5b');
    await release();
    expect(cached()).toEqual(['llama3.2:3b']);
  });

  it('keeps the newer installed list when an older request answers last', async () => {
    listings.gpu = { ok: true, models: [qwen] };
    await show('gpu', GPU_ID);
    const release = gateListing();
    act(() => pushPulls([failedPull('gpu')]));
    await flush();

    listings.gpu = { ok: true, models: [qwen, llama] };
    act(() => pushInstalled('gpu'));
    await flush();
    expect(hub.installed).toEqual({ ok: true, models: [qwen, llama] });
    // The older request read its answer, one model, when it was asked.
    await release();
    expect(hub.installed).toEqual({ ok: true, models: [qwen, llama] });
  });

  it('lists again only the shown server when a pull or removal on it finishes, re-checking it when shown as down', async () => {
    await show('gpu', GPU_ID);
    getStatus.mockClear();
    listInstalled.mockClear();

    act(() => pushInstalled('local'));
    await flush();
    expect(listInstalled).not.toHaveBeenCalled();

    act(() => pushInstalled('gpu'));
    await flush();
    expect(listInstalled.mock.calls).toEqual([['gpu']]);
    expect(getStatus).not.toHaveBeenCalled();

    statuses.gpu = down('gpu');
    await act(() => hub.refresh());
    expect(hub.status?.reachable).toBe(false);
    statuses.gpu = up('gpu');
    getStatus.mockClear();
    act(() => pushInstalled('gpu'));
    await flush();
    expect(getStatus.mock.calls).toEqual([['gpu']]);
    expect(hub.status?.reachable).toBe(true);
  });

  it('re-checks only the shown server, once, when one of its pulls fails or pauses', async () => {
    await show('gpu', GPU_ID);
    getStatus.mockClear();
    const shared = failedPull('shared');
    const gpuFailed = failedPull('gpu');

    act(() => pushPulls([shared]));
    await flush();
    expect(getStatus).not.toHaveBeenCalled();

    act(() => pushPulls([shared, gpuFailed]));
    await flush();
    expect(getStatus.mock.calls).toEqual([['gpu']]);

    act(() => pushPulls([shared, gpuFailed]));
    await flush();
    expect(getStatus).toHaveBeenCalledTimes(1);

    act(() => pushPulls([shared, gpuFailed, failedPull('gpu', 'paused', 'gpu/other#q')]));
    await flush();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it('checks the shown server again when it is saved at another address', async () => {
    await show('gpu', GPU_ID);
    const checks = getStatus.mock.calls.length;
    await show('gpu', serverIdentity({ ...GPU, address: 'http://192.168.1.50:11434' }));
    expect(getStatus).toHaveBeenCalledTimes(checks + 1);
    expect(getStatus).toHaveBeenLastCalledWith('gpu');
  });

  describe('while the server looks down', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('checks again on its own after each down answer, and stops once it answers', async () => {
      statuses.gpu = down('gpu');
      await show('gpu', GPU_ID);
      const checks = getStatus.mock.calls.length;
      for (let attempt = 1; attempt <= 2; attempt++) {
        // IPC deserializes a fresh status object for each response.
        statuses.gpu = down('gpu');
        await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS));
        expect(getStatus).toHaveBeenCalledTimes(checks + attempt);
      }

      statuses.gpu = up('gpu');
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS));
      await flush();
      expect(hub.installed).toEqual({ ok: true, models: [qwen, llama] });
      const settled = getStatus.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS * 3));
      expect(getStatus).toHaveBeenCalledTimes(settled);
    });

    it('stops checking when the screen closes', async () => {
      statuses.gpu = down('gpu');
      await show('gpu', GPU_ID);
      const checks = getStatus.mock.calls.length;
      act(() => root?.unmount());
      root = null;
      await act(() => vi.advanceTimersByTimeAsync(DOWN_RECHECK_MS * 3));
      expect(getStatus).toHaveBeenCalledTimes(checks);
    });
  });
});

describe('useModelServers', () => {
  async function showServers() {
    root = createRoot(document.createElement('div'));
    act(() => root?.render(<ServersProbe />));
    await flush();
  }

  it('forgets the cached list of a server saved at another address', async () => {
    installedCache.set('gpu', GPU_ID, [qwen], 1);
    await showServers();
    expect(cached()).toEqual(['qwen2.5:0.5b']);
    act(() => pushServers([{ ...GPU, address: 'http://192.168.1.50:11434' }]));
    expect(cached()).toBeNull();
  });

  it('falls back to no saved servers, and warns, when the list cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listServers = async () => {
      throw new Error('ipc down');
    };
    await showServers();
    expect(servers).toEqual([]);
    expect(warn).toHaveBeenCalledWith('Listing model servers failed', expect.any(Error));
    warn.mockRestore();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { FetchLike, OllamaEnvironment } from '@bike4mind/local-models';
import type { ServerEndpoint } from '@bike4mind/local-models/servers';
import { launchLockedMessage } from '@shared/modelServers';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import type { ProcessProbe } from './adoptedServers';
import type { LaunchRequest, Launchers, ServerHandle } from './LocalServerSupervisor';
import { LOCAL_OLLAMA_URL, ModelServerRegistry } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';

const KEY = 'router-key-zz';

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8').replace(/^enc:/, ''),
};

function memoryFile(): StoreFile {
  let contents: string | null = null;
  return {
    read: () => Promise.resolve(contents),
    write: next => {
      contents = next;
      return Promise.resolve();
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
const timedOut = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

interface FakeHandle extends ServerHandle {
  request: LaunchRequest;
  crash(code: number): void;
}

/**
 * Origins answer only while `up` holds them: Ollama on any port but 8090, a keyed llama-server router on 8090.
 * Starting a server puts its origin up; stopping or crashing takes it down.
 */
function setup(
  options: {
    readOllamaEnv?: (url: string) => Promise<OllamaEnvironment | null>;
    portFree?: (port: number) => Promise<boolean>;
    ownedServers?: StoreFile;
    processes?: ProcessProbe;
    platform?: NodeJS.Platform;
  } = {}
) {
  const up = new Set<string>();
  /** Origins whose connections time out instead of being refused. */
  const silent = new Set<string>();
  const calls: { origin: string; path: string; credentials: Record<string, string> | null }[] = [];
  const answer = (origin: string, path: string, credentials: Record<string, string> | null): Response => {
    if (origin.endsWith(':8090')) {
      if (credentials?.authorization !== `Bearer ${KEY}`) return json({ error: 'unauthorized' }, 401);
      if (path === '/v1/models') return json({ data: [{ id: 'tiny', owned_by: 'llamacpp' }] });
      if (path === '/props') return json({ build_info: 'b7000', role: 'router' });
      return json({ error: 'not found' }, 404);
    }
    if (path === '/api/version') return json({ version: '0.12.0' });
    if (path === '/api/tags') return json({ models: [{ name: 'qwen2.5:0.5b' }] });
    if (path === '/api/show')
      return json({ capabilities: ['completion'], model_info: { 'qwen2.context_length': 32768 } });
    return json({ error: 'not found' }, 404);
  };
  const fetchFor =
    (endpoint: ServerEndpoint): FetchLike =>
    async input => {
      const url = new URL(String(input));
      const credentials = endpoint.credentialHeaders();
      calls.push({ origin: url.origin, path: url.pathname, credentials });
      if (silent.has(url.origin)) throw timedOut();
      if (!up.has(url.origin)) throw refused();
      return answer(url.origin, url.pathname, credentials);
    };
  const localFetch: FetchLike = async input => {
    const url = new URL(String(input));
    if (!up.has(url.origin)) throw refused();
    return answer(url.origin, url.pathname, null);
  };
  const handles: FakeHandle[] = [];
  const launchers: Launchers = {
    program: vi.fn(async () => ({ path: '/opt/fake/bin' })),
    start: vi.fn(async (_program: string, request: LaunchRequest) => {
      const origin = `http://127.0.0.1:${request.port}`;
      let settle: (exit: { code: number | null; signal: NodeJS.Signals | null; stopped: boolean }) => void = () => {};
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stopped: boolean }>(
        resolve => (settle = resolve)
      );
      const handle: FakeHandle = {
        pid: 4000 + handles.length,
        running: true,
        exited,
        request,
        ...(request.runtime === 'llama-server' ? { apiKey: KEY } : {}),
        log: () => ['msg="Listening on 127.0.0.1"', 'panic: out of memory'],
        stop: async () => {
          (handle as { running: boolean }).running = false;
          up.delete(origin);
          settle({ code: 0, signal: null, stopped: true });
        },
        crash: code => {
          (handle as { running: boolean }).running = false;
          up.delete(origin);
          settle({ code, signal: null, stopped: false });
        },
      };
      handles.push(handle);
      up.add(origin);
      return handle;
    }),
  };
  const store = new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined });
  const localSpecsChanged = vi.fn();
  const edited = vi.fn();
  const changed = vi.fn();
  const registry = new ModelServerRegistry({
    store,
    logger: { debug: () => undefined, warn: () => undefined },
    fetchFor,
    localFetch,
    resolve: async () => [],
    launchers,
    localSpecsChanged,
    edited,
    changed,
    readOllamaEnv: options.readOllamaEnv,
    portFree: options.portFree ?? (async port => !up.has(`http://127.0.0.1:${port}`)),
    ownedServers: options.ownedServers,
    ownedCipher: cipher,
    processes: options.processes,
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const saved = vi.fn();
  registry.onServerSaved(saved);
  return { registry, up, silent, calls, handles, launchers, store, localSpecsChanged, edited, saved, changed };
}

const none = { type: 'none' as const };
const local = async (registry: ModelServerRegistry) => (await registry.views())[0];

describe('ModelServerRegistry launching servers', () => {
  it("starts this computer's Ollama with its saved settings, sizes with them, and owns it until stopped", async () => {
    const { registry, launchers, localSpecsChanged, saved } = setup();
    await registry.check('local');
    expect((await local(registry)).launch).toMatchObject({ owner: 'none', canStart: true, sizingKvCacheType: 'f16' });

    await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
    expect(registry.localKvCacheType()).toBeUndefined();
    const views = await registry.startServer('local');
    expect(launchers.start).toHaveBeenCalledWith(
      '/opt/fake/bin',
      { runtime: 'ollama', port: 11434, settings: { kvCacheType: 'q8_0' } },
      expect.any(AbortSignal)
    );
    expect(views[0].health.state).toBe('online');
    expect(views[0].launch).toMatchObject({
      owner: 'desktop',
      canStart: false,
      pendingRestart: false,
      sizingKvCacheType: 'q8_0',
    });
    expect(registry.localKvCacheType()).toBe('q8_0');
    expect(localSpecsChanged).toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith('local');

    await registry.update('local', { launch: { kvCacheType: 'q4_0' } });
    expect((await local(registry)).launch).toMatchObject({ pendingRestart: true, sizingKvCacheType: 'q8_0' });
    const restarted = await registry.restartServer('local');
    expect(restarted[0].launch).toMatchObject({ owner: 'desktop', pendingRestart: false, sizingKvCacheType: 'q4_0' });
    expect(launchers.start).toHaveBeenCalledTimes(2);

    const stopped = await registry.stopServer('local');
    expect(stopped[0].launch).toMatchObject({ owner: 'none', canStart: true, sizingKvCacheType: 'f16' });
    expect(registry.localKvCacheType()).toBeUndefined();
  });

  it('leaves an Ollama it did not start alone and refuses its launch settings', async () => {
    const { registry, up, launchers } = setup();
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    const launch = (await local(registry)).launch!;
    expect(launch).toMatchObject({ owner: 'other', canStart: false, observed: null, sizingKvCacheType: 'f16' });
    const locked = launchLockedMessage(launch)!;
    expect(locked).toBe(
      "This Ollama server was not started by Bike4Mind Desktop, so Desktop can't apply these settings. To use them, stop that server and start it from Desktop."
    );
    await expect(registry.update('local', { launch: { kvCacheType: 'q8_0' } })).rejects.toThrow(locked);
    await expect(registry.startServer('local')).rejects.toThrow('Something already answers at 127.0.0.1:11434');
    await expect(registry.stopServer('local')).rejects.toThrow(locked);
    expect(launchers.start).not.toHaveBeenCalled();
    expect(launchers.program).not.toHaveBeenCalled();
  });

  it("shows an unmanaged Ollama's own launch variables and sizes with its cache type", async () => {
    const env: OllamaEnvironment = { OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_HOST: '127.0.0.1:11434' };
    const readOllamaEnv = vi.fn(async () => env);
    const { registry, up, localSpecsChanged } = setup({ readOllamaEnv });
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect(readOllamaEnv).toHaveBeenCalledWith(LOCAL_OLLAMA_URL);
    expect((await local(registry)).launch).toMatchObject({
      owner: 'other',
      observed: { OLLAMA_KV_CACHE_TYPE: 'q8_0' },
      sizingKvCacheType: 'q8_0',
    });
    expect(registry.localKvCacheType()).toBe('q8_0');
    expect(localSpecsChanged).toHaveBeenCalledTimes(1);
  });

  it('sizes an unmanaged Ollama with f16 when its flash attention is off or its settings cannot be read', async () => {
    const off = setup({ readOllamaEnv: async () => ({ OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '0' }) });
    off.up.add(LOCAL_OLLAMA_URL);
    await off.registry.check('local');
    expect((await local(off.registry)).launch).toMatchObject({
      observed: { OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '0' },
      sizingKvCacheType: 'f16',
    });
    const unread = setup({ readOllamaEnv: async () => null });
    unread.up.add(LOCAL_OLLAMA_URL);
    await unread.registry.check('local');
    expect((await local(unread.registry)).launch).toMatchObject({ observed: null, sizingKvCacheType: 'f16' });
  });

  it('sizes an unmanaged Ollama whose settings cannot be read with its saved launch settings', async () => {
    const { registry, up } = setup({ readOllamaEnv: async () => null });
    await registry.check('local');
    await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect((await local(registry)).launch).toMatchObject({
      owner: 'other',
      observed: null,
      sizingKvCacheType: 'q8_0',
      sizingFlashAttention: 'on',
    });
    expect(registry.localKvCacheType()).toBe('q8_0');
  });

  it('sizes with the flash attention the Ollama Desktop started runs with, auto when nothing says otherwise', async () => {
    const { registry, localSpecsChanged } = setup();
    await registry.check('local');
    expect(registry.flashAttention('local')).toBeUndefined();
    await registry.update('local', { launch: { flashAttention: 'off' } });
    expect(registry.flashAttention('local')).toBeUndefined();
    await registry.startServer('local');
    expect(registry.flashAttention('local')).toBe('off');
    expect((await local(registry)).launch).toMatchObject({ sizingFlashAttention: 'off', sizingKvCacheType: 'f16' });
    expect(localSpecsChanged).toHaveBeenCalledTimes(1);

    // A quantized cache left at auto starts with flash attention on (ollamaLaunchEnv).
    await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
    localSpecsChanged.mockClear();
    await registry.restartServer('local');
    expect(registry.flashAttention('local')).toBe('on');
    expect(localSpecsChanged).toHaveBeenCalled();
    await registry.stopServer('local');
    expect(registry.flashAttention('local')).toBeUndefined();
  });

  it('sizes an unmanaged Ollama with the flash attention read from it, and sees it change', async () => {
    let env: OllamaEnvironment = { OLLAMA_FLASH_ATTENTION: 'false' };
    const { registry, up, localSpecsChanged } = setup({ readOllamaEnv: async () => env });
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect(registry.flashAttention('local')).toBe('off');
    expect((await local(registry)).launch).toMatchObject({ owner: 'other', sizingFlashAttention: 'off' });
    expect(localSpecsChanged).toHaveBeenCalledTimes(1);

    const lan = setup({ readOllamaEnv: async () => env });
    lan.up.add('http://192.168.1.20:11434');
    const [, remote] = await lan.registry.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'lan',
      kind: 'ollama',
      access: 'chat',
    });
    expect(lan.registry.flashAttention(remote.id)).toBeUndefined();

    env = { OLLAMA_FLASH_ATTENTION: '1' };
    up.delete(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect(registry.flashAttention('local')).toBeUndefined();
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect(registry.flashAttention('local')).toBe('on');
    expect(localSpecsChanged).toHaveBeenCalledTimes(3);
  });

  it('offers what an unmanaged Ollama ran with as the launch prefill, also after it stops', async () => {
    const { registry, up } = setup({ readOllamaEnv: async () => ({ OLLAMA_KV_CACHE_TYPE: 'q8_0' }) });
    await registry.check('local');
    expect((await local(registry)).launch?.prefill).toBeNull();
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    const prefill = { settings: { kvCacheType: 'q8_0' }, from: 'OLLAMA_KV_CACHE_TYPE=q8_0' };
    expect((await local(registry)).launch).toMatchObject({ owner: 'other', prefill });
    up.delete(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect((await local(registry)).launch).toMatchObject({ owner: 'none', canStart: true, prefill });
  });

  it('never reads the settings of the Ollama it started', async () => {
    const readOllamaEnv = vi.fn(async () => ({ OLLAMA_KV_CACHE_TYPE: 'q4_0' }));
    const { registry } = setup({ readOllamaEnv });
    await registry.check('local');
    await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
    await registry.startServer('local');
    await registry.check('local');
    expect(readOllamaEnv).not.toHaveBeenCalled();
    expect(registry.localKvCacheType()).toBe('q8_0');
  });

  it('saves an address nothing answers at yet, then runs a keyed llama-server router there', async () => {
    const { registry, calls, launchers } = setup();
    const address = { address: 'http://127.0.0.1:8090', credential: none };
    const probe = await registry.probe(address);
    expect(probe).toMatchObject({ ok: false, launchable: true, address: 'http://127.0.0.1:8090' });
    await expect(
      registry.add({ ...address, name: 'router', kind: 'openai-compatible', access: 'chat' })
    ).rejects.toThrow();
    const [, added] = await registry.add({
      ...address,
      name: 'router',
      kind: 'openai-compatible',
      access: 'chat',
      launch: true,
    });
    expect(added.launch).toMatchObject({ runtime: 'llama-server', owner: 'none', canStart: true, noun: 'server' });

    await registry.update(added.id, { launch: { modelsDir: '/models', flashAttention: 'on' } });
    const [, running] = await registry.startServer(added.id);
    expect(launchers.start).toHaveBeenCalledWith(
      '/opt/fake/bin',
      { runtime: 'llama-server', port: 8090, settings: { modelsDir: '/models', flashAttention: 'on' } },
      expect.any(AbortSignal)
    );
    expect(running.health.state).toBe('online');
    expect(running.launch).toMatchObject({ owner: 'desktop', noun: 'llama-server', sizingKvCacheType: 'f16' });
    const keyed = calls.filter(call => call.origin.endsWith(':8090') && call.credentials);
    expect(keyed.length).toBeGreaterThan(0);
    expect(keyed.every(call => call.credentials?.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.stringify(await registry.views())).not.toContain(KEY);

    await expect(registry.update(added.id, { kind: 'ollama' })).rejects.toThrow('Stop the server Desktop started');
    await expect(registry.update(added.id, { launch: { kvCacheType: 'q8_0' } })).rejects.toThrow(
      'applies to Ollama servers only'
    );
  });

  it('offers to start a server at a loopback port that times out instead of refusing, when the port is free', async () => {
    const { registry, silent, launchers } = setup();
    silent.add('http://127.0.0.1:8090');
    const address = { address: 'http://127.0.0.1:8090', credential: none };
    expect(await registry.probe(address)).toMatchObject({ ok: false, launchable: true });
    const [, added] = await registry.add({
      ...address,
      name: 'router',
      kind: 'openai-compatible',
      access: 'chat',
      launch: true,
    });
    expect(added.launch).toMatchObject({ runtime: 'llama-server', owner: 'none' });
    expect(launchers.start).not.toHaveBeenCalled();
  });

  it('does not offer a start at a loopback port something holds without answering', async () => {
    const portFree = vi.fn(async () => false);
    const { registry, silent } = setup({ portFree });
    silent.add('http://127.0.0.1:8090');
    const address = { address: 'http://127.0.0.1:8090', credential: none };
    expect((await registry.probe(address)).launchable).toBeUndefined();
    expect(portFree).toHaveBeenCalledWith(8090);
    await expect(
      registry.add({ ...address, name: 'router', kind: 'openai-compatible', access: 'chat', launch: true })
    ).rejects.toThrow('did not answer in time');
  });

  it('refuses a launch add for an address that is not on this computer', async () => {
    const { registry, launchers } = setup();
    const address = { address: 'http://192.168.1.20:11434', credential: none };
    expect((await registry.probe(address)).launchable).toBeUndefined();
    await expect(
      registry.add({ ...address, name: 'lan', kind: 'ollama', access: 'chat', launch: true })
    ).rejects.toThrow();
    expect(launchers.start).not.toHaveBeenCalled();
  });

  it('treats a server on another machine as remote, with no Start and no launch settings', async () => {
    const { registry, up, launchers } = setup();
    up.add('http://192.168.1.20:11434');
    const [, added] = await registry.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    expect(added.launch).toMatchObject({ owner: 'remote', canStart: false, observed: null, problem: null });
    const locked = launchLockedMessage(added.launch!)!;
    expect(locked).toBe(
      "This Ollama server runs on another machine, so Desktop can't start it or apply these settings."
    );
    await expect(registry.update(added.id, { launch: { kvCacheType: 'q8_0' } })).rejects.toThrow(locked);
    up.delete('http://192.168.1.20:11434');
    await registry.check(added.id);
    await expect(registry.startServer(added.id)).rejects.toThrow(locked);
    expect(launchers.start).not.toHaveBeenCalled();
  });

  it("chats with a Desktop-started Ollama's cache type and says why it stopped when it exits on its own", async () => {
    const { registry, handles, edited } = setup();
    const [, added] = await registry.add({
      address: 'http://127.0.0.1:11500',
      credential: none,
      name: 'spare',
      kind: 'ollama',
      access: 'chat',
      launch: true,
    });
    await registry.update(added.id, { launch: { kvCacheType: 'q8_0' } });
    await registry.startServer(added.id);
    const chat = registry.chatFor(`srv-${added.id}`)!;
    const model = `local:srv-${added.id}:qwen2.5:0.5b`;
    expect((await chat.loadOffer!(model)).kvCache).toEqual({ type: 'q8_0' });
    expect(registry.kvCacheType(added.id)).toBe('q8_0');
    expect(edited).toHaveBeenCalled();

    handles[0].crash(2);
    await vi.waitFor(async () => expect((await registry.views())[1].launch?.owner).toBe('none'));
    const [, after] = await registry.views();
    expect(after.launch).toMatchObject({
      canStart: true,
      problem: 'Ollama stopped (code 2): panic: out of memory',
      sizingKvCacheType: 'f16',
    });
    expect((await chat.loadOffer!(model)).kvCache).toEqual({ type: 'f16' });
  });

  it('reports a failed start and keeps nothing running', async () => {
    const { registry, launchers } = setup();
    vi.mocked(launchers.start).mockRejectedValueOnce(new Error('port 11434 is in use'));
    await registry.check('local');
    await expect(registry.startServer('local')).rejects.toThrow('port 11434 is in use');
    expect((await local(registry)).launch).toMatchObject({ owner: 'none', problem: 'port 11434 is in use' });
    vi.mocked(launchers.program).mockResolvedValueOnce({ problem: 'Desktop could not find Ollama on this computer.' });
    await expect(registry.startServer('local')).rejects.toThrow('could not find Ollama');
  });

  it('stops what it started when a server is removed, and everything on quit', async () => {
    const { registry, handles } = setup();
    const [, added] = await registry.add({
      address: 'http://127.0.0.1:11500',
      credential: none,
      name: 'spare',
      kind: 'ollama',
      access: 'chat',
      launch: true,
    });
    await registry.check('local');
    await registry.startServer(added.id);
    await registry.startServer('local');
    expect(handles.map(handle => handle.running)).toEqual([true, true]);
    await registry.remove(added.id);
    expect(handles.map(handle => handle.running)).toEqual([false, true]);
    await registry.stopLocalServers();
    expect(handles[1].running).toBe(false);
  });

  it('keeps a server saved and manageable when stopping it for removal fails', async () => {
    const { registry, handles, store } = setup();
    const [, added] = await registry.add({
      address: 'http://127.0.0.1:11500',
      credential: none,
      name: 'spare',
      kind: 'ollama',
      access: 'chat',
      launch: true,
    });
    await registry.startServer(added.id);
    const stop = vi.spyOn(handles[0], 'stop').mockRejectedValueOnce(new Error('Stop failed'));
    await expect(registry.remove(added.id)).rejects.toThrow('Stop failed');
    expect((await store.list()).map(server => server.id)).toContain(added.id);
    expect((await registry.views()).find(server => server.id === added.id)?.launch?.owner).toBe('desktop');
    stop.mockRestore();
    await registry.remove(added.id);
    expect((await store.list()).map(server => server.id)).not.toContain(added.id);
  });

  it('takes back the Ollama it started before Desktop exited without stopping it, with its launch settings', async () => {
    const record = {
      id: 'local',
      runtime: 'ollama',
      pid: 777,
      startTime: '1700000000:42',
      port: 11434,
      startedAt: '2026-11-04T00:00:00.000Z',
      settings: { kvCacheType: 'q8_0' },
    };
    const ownedServers = memoryFile();
    await ownedServers.write(JSON.stringify({ version: 1, servers: [record] }));
    const live = new Map([[777, record.startTime]]);
    const signal = vi.fn((pid: number) => {
      live.delete(pid);
      up.delete(LOCAL_OLLAMA_URL);
    });
    const processes: ProcessProbe = {
      startTime: async pid => live.get(pid) ?? null,
      leadsGroup: async () => true,
      listening: async () => true,
      signal,
    };
    const { registry, up, launchers } = setup({ ownedServers, processes });
    up.add(LOCAL_OLLAMA_URL);
    await registry.check('local');
    expect((await local(registry)).launch).toMatchObject({
      owner: 'desktop',
      pendingRestart: true,
      sizingKvCacheType: 'q8_0',
      sizingFlashAttention: 'on',
    });
    expect(registry.localKvCacheType()).toBe('q8_0');

    const [stopped] = await registry.stopServer('local');
    expect(signal).toHaveBeenCalledWith(777, 'SIGTERM');
    expect(stopped.launch).toMatchObject({ owner: 'none', canStart: true });
    expect(JSON.parse((await ownedServers.read())!).servers).toEqual([]);
    expect(launchers.start).not.toHaveBeenCalled();
  });

  it('does not take back a server listed for another port or runtime than the saved address', async () => {
    const base = {
      pid: 777,
      startTime: '1700000000:42',
      startedAt: '2026-11-04T00:00:00.000Z',
      settings: {},
    };
    const records = [
      { ...base, id: 'local', runtime: 'ollama', port: 11500 },
      {
        ...base,
        id: 'local',
        runtime: 'llama-server',
        port: 11434,
        sealedKey: Buffer.from('enc:key', 'utf8').toString('base64'),
      },
    ];
    for (const record of records) {
      const ownedServers = memoryFile();
      await ownedServers.write(JSON.stringify({ version: 1, servers: [record] }));
      const signal = vi.fn();
      const processes: ProcessProbe = {
        startTime: async () => record.startTime,
        leadsGroup: async () => true,
        listening: async () => true,
        signal,
      };
      const { registry, up } = setup({ ownedServers, processes });
      up.add(LOCAL_OLLAMA_URL);
      await registry.check('local');
      expect((await local(registry)).launch).toMatchObject({ owner: 'other' });
      expect(JSON.parse((await ownedServers.read())!).servers).toEqual([]);
      expect(signal).not.toHaveBeenCalled();
    }
  });

  it('tells a Windows user how to free a server Desktop cannot take back after a crash', async () => {
    const hint =
      'If Desktop was running it before it closed unexpectedly, end ollama.exe or llama-server.exe in Task Manager, then start it here.';
    for (const platform of ['win32', 'linux'] as const) {
      const { registry, up } = setup({ platform });
      up.add(LOCAL_OLLAMA_URL);
      await registry.check('local');
      const view = (await local(registry)).launch!;
      expect(launchLockedMessage(view)!.includes(hint)).toBe(platform === 'win32');
      await expect(registry.update('local', { launch: { kvCacheType: 'q8_0' } })).rejects.toThrow(
        platform === 'win32' ? hint : 'start it from Desktop.'
      );
      await expect(registry.startServer('local')).rejects.toThrow(
        platform === 'win32' ? hint : 'Something already answers at 127.0.0.1:11434. Stop it first.'
      );
    }
  });

  it('sizes a remote Ollama with the KV cache type entered under Hardware', async () => {
    const { registry, up } = setup();
    up.add('http://192.168.1.20:11434');
    const [, added] = await registry.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    expect(registry.kvCacheType(added.id)).toBeUndefined();
    const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false, kvCacheType: 'q8_0' as const };
    const [, updated] = await registry.update(added.id, { specs });
    expect(updated.specs).toEqual(specs);
    expect(updated.launch).toMatchObject({ owner: 'remote', sizingKvCacheType: 'q8_0' });
    expect(registry.kvCacheType(added.id)).toBe('q8_0');
    const chat = registry.chatFor(`srv-${added.id}`)!;
    expect((await chat.loadOffer!(`local:srv-${added.id}:qwen2.5:0.5b`)).kvCache).toEqual({ type: 'q8_0' });
  });

  it('counts a loopback port held by something that does not answer as in use, and offers no Start', async () => {
    let held = true;
    const { registry, launchers } = setup({ portFree: async () => !held });
    await registry.check('local');
    const message = 'Another program is using 127.0.0.1:11434 but does not answer there. Stop it, then check again.';
    expect((await local(registry)).launch).toMatchObject({ owner: 'other', canStart: false, problem: message });
    await expect(registry.startServer('local')).rejects.toThrow(message);
    expect(launchers.start).not.toHaveBeenCalled();

    held = false;
    await registry.check('local');
    expect((await local(registry)).launch).toMatchObject({ owner: 'none', canStart: true, problem: null });
  });

  it('refuses settings Desktop could not start with', async () => {
    const { registry } = setup();
    await registry.check('local');
    await expect(registry.update('local', { launch: { kvCacheType: 'q8_0', flashAttention: 'off' } })).rejects.toThrow(
      'needs flash attention'
    );
    await expect(registry.update('local', { launch: { modelsDir: '/m' } })).rejects.toThrow(
      'uses its own models folder'
    );
  });
});

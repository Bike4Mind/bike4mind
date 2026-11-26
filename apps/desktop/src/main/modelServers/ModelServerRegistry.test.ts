import { describe, expect, it, vi, afterEach } from 'vitest';
import { ServerCredentialsError, ServerUnreachableError } from './errors';
import {
  foundServers,
  LISTED_FRESH_MS,
  ModelServerRegistry,
  PICKER_CHECK_WAIT_MS,
  PICKER_LIST_WAIT_MS,
  LOCAL_OLLAMA_URL,
} from './ModelServerRegistry';
import { ModelServerStore, credentialHeaders, MAX_MODEL_SERVERS } from './ModelServerStore';
import { inertLaunchers } from './testLaunchers';
import {
  describeSshFailure,
  SshConnectionError,
  createSshFetch,
  localModelId,
  parseLocalModelId,
  QUANTIZED_KV_CACHE_TYPES,
  readSpecs,
  serverManagement,
  serverRuntimeId,
  type ServerEndpoint,
  type SshEndpoint,
  type SshDeps,
} from '@bike4mind/local-models/servers';
import { ModelCatalog } from '../chat/ModelCatalog';
import { LocalModels } from './LocalModels';
import * as shared from '@shared/modelServers';
import {
  launchLockedMessage,
  type ModelServerProbeInput,
  type ModelServerProbeResult,
  type ModelServerUpdateInput,
  type ModelServerCredentialInput,
  type ModelServerKind,
  type ModelServerMutationResult,
  type ModelServerView,
} from '@shared/modelServers';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { IPC_CHANNELS } from '@shared/ipc';
import { OllamaLocal } from '../chat/OllamaLocal';
import { registerModelServersIpc, specsInput } from './ipc';
import { openedAs, sealedAs, versionedCipher } from '../secrets/versionedCipher.testHelper';
import { machineView } from '../models/fit';
import { LOCAL_NETWORK_HINT, localNetworkHint, withLocalNetworkHint } from './localNetworkHint';
import type { FetchLike, OllamaEnvironment, OpenAICompatibleProduct } from '@bike4mind/local-models';
import type { StoreFile } from '../chat/mcp/McpServerStore';
import type { SecretCipher } from '../../host/ports';
import * as chat from '@shared/chat';
import type { ChatModelOption } from '@shared/chat';
import type { ProcessProbe } from './adoptedServers';
import type { LaunchRequest, Launchers, ServerHandle } from './LocalServerSupervisor';
import type { ChildProcess } from 'node:child_process';
import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { IpcMain } from 'electron';
import type { CompletionStreamEvent } from '../chat/streamEvents';

// Conditions here hold a few promise turns in; vi.waitFor's default 50ms poll would wait each one out.
// Under fake timers each poll also advances the clock by its interval, so those keep the default.
const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { ...(vi.isFakeTimers() ? {} : { interval: 1 }), ...options });

const TOKEN = 'tok-secret-zz';

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

type Handler = (path: string, credentials: Record<string, string> | null) => Response | Promise<Response>;

/** An Ollama that answers on every origin; `down`, `forbidden` and `wantToken` change how it answers. */
function fakeOllama(models = ['qwen2.5:0.5b']) {
  const state = {
    down: new Set<string>(),
    forbidden: false,
    wantToken: null as string | null,
    versionGate: null as Promise<void> | null,
    /** Holds `/api/tags` on an origin until it settles. */
    tagsGates: new Map<string, Promise<void>>(),
    /** Holds `/api/tags` on an origin until it settles, after `skip` requests have passed. */
    tagsGatesAfter: new Map<string, { skip: number; gate: Promise<void> }>(),
    /** Delays every `/api/tags` on an origin by this many ms. */
    tagsDelays: new Map<string, number>(),
    /** The system error code a request to a `down` origin fails with. */
    downCode: 'ECONNREFUSED',
  };
  const calls: { origin: string; path: string; credentials: Record<string, string> | null }[] = [];
  const handler: Handler = (path, credentials) => {
    if (state.forbidden) return new Response('', { status: 403 });
    if (state.wantToken && credentials?.authorization !== `Bearer ${state.wantToken}`)
      return json({ error: 'unauthorized' }, 401);
    if (path === '/api/version') return json({ version: '0.12.0' });
    if (path === '/api/tags') return json({ models: models.map(name => ({ name })) });
    if (path === '/api/show')
      return json({ capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 } });
    if (path === '/v1/models') return json({ error: 'not found' }, 404);
    return json({ error: 'not found' }, 404);
  };
  const fetchFor =
    (endpoint: ServerEndpoint): FetchLike =>
    async input => {
      const url = new URL(String(input));
      const credentials = endpoint.credentialHeaders();
      calls.push({ origin: url.origin, path: url.pathname, credentials });
      if (state.down.has(url.origin)) throw new TypeError('fetch failed', { cause: { code: state.downCode } });
      if (url.pathname === '/api/version') await state.versionGate;
      if (url.pathname === '/api/tags') {
        await state.tagsGates.get(url.origin);
        const later = state.tagsGatesAfter.get(url.origin);
        if (later && later.skip-- <= 0) await later.gate;
        const delay = state.tagsDelays.get(url.origin);
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      }
      return handler(url.pathname, credentials);
    };
  return { state, calls, fetchFor };
}

function registry(
  fake: ReturnType<typeof fakeOllama>,
  resolve: Record<string, string[]> | ((host: string) => Promise<string[]>) = {},
  options: { platform?: NodeJS.Platform; logger?: { debug(message: string): void; warn(message: string): void } } = {}
) {
  const store = new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined });
  const changed = vi.fn();
  const listedLate = vi.fn();
  const edited = vi.fn();
  const instance = new ModelServerRegistry({
    launchers: inertLaunchers(),
    store,
    logger: options.logger ?? { debug: () => undefined, warn: () => undefined },
    platform: options.platform,
    changed,
    edited,
    listedLate,
    fetchFor: fake.fetchFor,
    localFetch: async () => json({ version: '0.12.0' }),
    resolve: typeof resolve === 'function' ? resolve : async host => resolve[host] ?? [],
  });
  return { registry: instance, store, changed, edited, listedLate };
}

/** The picker list after `ms` of fake time; undefined while it is still waiting. */
async function listedAfter(servers: ModelServerRegistry, ms: number): Promise<ChatModelOption[] | undefined> {
  vi.useFakeTimers();
  try {
    let listed: ChatModelOption[] | undefined;
    void servers.models().then(result => {
      listed = result;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return listed;
  } finally {
    vi.useRealTimers();
  }
}

const none = { type: 'none' as const };

describe('ModelServerRegistry', () => {
  it('lists this computer first, then saved servers', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const views = await servers.views();
    expect(views.map(view => view.name)).toEqual(['This computer', 'gpu box']);
    expect(views[1]).toMatchObject({
      kind: 'ollama',
      access: 'chat',
      unencrypted: true,
      health: { state: 'online', version: '0.12.0' },
    });
  });

  it('saves entered hardware for a server and for this computer, and says when this computer changed', async () => {
    const fake = fakeOllama();
    const file = memoryFile();
    const quiet = { debug: () => undefined, warn: () => undefined };
    const localSpecsChanged = vi.fn();
    const servers = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store: new ModelServerStore(cipher, file, quiet),
      logger: { debug: () => undefined, warn: () => undefined },
      fetchFor: fake.fetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => [],
      localSpecsChanged,
    });
    const saved = vi.fn();
    servers.onServerSaved(saved);
    const [, added] = await servers.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const specs = { ramGiB: 64, gpuMemoryGiB: 24, bandwidthGBps: 1008, unified: false };

    const views = await servers.update(added.id, { specs });
    expect(views[1].specs).toEqual(specs);
    expect(servers.specs(added.id)).toEqual(specs);
    expect(saved).toHaveBeenLastCalledWith(added.id);
    expect(localSpecsChanged).not.toHaveBeenCalled();

    const local = { ...specs, gpuMemoryGiB: null };
    expect((await servers.update('local', { specs: local }))[0].specs).toEqual(local);
    expect(servers.specs('local')).toEqual(local);
    expect(saved).toHaveBeenLastCalledWith('local');
    expect(localSpecsChanged).toHaveBeenCalledTimes(1);
    await expect(servers.update('local', { name: 'mine' })).rejects.toThrow('no other settings');

    // A restart reads this computer's specs back and says so, since sizing may have run on the probe alone.
    const restarted = vi.fn();
    const again = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store: new ModelServerStore(cipher, file, quiet),
      logger: quiet,
      fetchFor: fake.fetchFor,
      localSpecsChanged: restarted,
    });
    expect((await again.views())[0].specs).toEqual(local);
    expect(restarted).toHaveBeenCalledTimes(1);
  });

  it('detects Ollama by what it answers and marks plain http on a private address unencrypted', async () => {
    const { registry: servers } = registry(fakeOllama());
    const probe = await servers.probe({ address: '192.168.1.20:11434', credential: none });
    expect(probe).toMatchObject({
      ok: true,
      kind: 'ollama',
      version: '0.12.0',
      models: 1,
      unencrypted: true,
      openToAnyone: false,
    });
  });

  it('refuses credentials over plain http to a private address before sending anything', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    const probe = await servers.probe({
      address: 'http://192.168.1.20:11434',
      credential: { type: 'bearer', token: TOKEN },
    });
    expect(probe.ok).toBe(false);
    expect(probe.error).toMatch(/https/);
    expect(fake.calls).toHaveLength(0);
  });

  it('judges a name by the least trusted address it resolves to', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake, { 'box.example.test': ['127.0.0.1', '203.0.113.9'] });
    const probe = await servers.probe({ address: 'http://box.example.test:11434', credential: none });
    expect(probe.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('warns before saving a public server that answers without credentials', async () => {
    const fake = fakeOllama();
    const { registry: servers, store } = registry(fake, { 'models.example.test': ['203.0.113.9'] });
    const input = {
      address: 'https://models.example.test',
      credential: none,
      name: 'public',
      kind: 'ollama' as const,
      access: 'chat' as const,
    };
    expect((await servers.probe(input)).openToAnyone).toBe(true);
    await expect(servers.add(input)).rejects.toThrow(/anyone/);
    expect(await store.list()).toHaveLength(0);
    await servers.add({ ...input, acceptOpen: true });
    expect(await store.list()).toHaveLength(1);
  });

  it('does not warn when the public server refuses requests without the credential', async () => {
    const fake = fakeOllama();
    fake.state.wantToken = TOKEN;
    const { registry: servers } = registry(fake, { 'models.example.test': ['203.0.113.9'] });
    const probe = await servers.probe({
      address: 'https://models.example.test',
      credential: { type: 'bearer', token: TOKEN },
    });
    expect(probe).toMatchObject({ ok: true, openToAnyone: false });
  });

  it('asks for credentials when the server answers 401', async () => {
    const fake = fakeOllama();
    fake.state.wantToken = TOKEN;
    const { registry: servers } = registry(fake);
    const probe = await servers.probe({ address: 'http://127.0.0.2:11434', credential: none });
    expect(probe).toMatchObject({ ok: false, needsCredentials: true });
  });

  it("refuses this computer's own Ollama address before sending anything", async () => {
    const fake = fakeOllama();
    const { registry: servers, store } = registry(fake);
    for (const address of [
      'http://127.0.0.1:11434',
      '127.0.0.1:11434',
      'localhost:11434',
      'http://localhost.:11434',
      'http://[::1]:11434/',
      '0.0.0.0:11434',
      'http://[::ffff:127.0.0.1]:11434',
    ]) {
      const probe = await servers.probe({ address, credential: none });
      expect(probe).toMatchObject({ ok: false, address: null });
      expect(probe.error).toMatch(/is This computer, which is already listed.*different local port/);
    }
    await expect(
      servers.add({ address: '127.0.0.1:11434', credential: none, name: 'tunnel', kind: 'ollama', access: 'chat' })
    ).rejects.toThrow(/This computer/);
    expect(fake.calls).toHaveLength(0);
    expect(await store.list()).toHaveLength(0);
    expect((await servers.probe({ address: '127.0.0.1:21434', credential: none })).ok).toBe(true);
  });

  it('keeps the session-only message through the first picker load after a restart', async () => {
    const fake = fakeOllama();
    fake.state.wantToken = TOKEN;
    const file = memoryFile();
    const noKeyring: SecretCipher = { ...cipher, isEncryptionAvailable: () => false };
    const silent = { debug: () => undefined, warn: () => undefined };
    await new ModelServerStore(noKeyring, file, silent).add(
      {
        name: 'gpu box',
        kind: 'ollama',
        transport: { type: 'http', baseUrl: 'http://127.0.0.2:11434' },
        access: 'chat',
      },
      { type: 'bearer', token: TOKEN }
    );
    const servers = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store: new ModelServerStore(noKeyring, file, silent),
      logger: silent,
      fetchFor: fake.fetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => [],
    });
    const [model] = await servers.models();
    expect(fake.calls).toHaveLength(0);
    expect(model).toBeUndefined();
    const view = (await servers.views())[1];
    expect(view.health.state).toBe('credentials');
    expect(view.health.error).toMatch(/kept only until Desktop quit/);
  });

  describe('a server that answers 403', () => {
    const notCredentials = /credential|token/i;

    it('reports the refusal when testing the address, without asking for credentials', async () => {
      const fake = fakeOllama();
      fake.state.forbidden = true;
      const { registry: servers } = registry(fake);
      const probe = await servers.probe({ address: 'http://127.0.0.2:11434', credential: none });
      expect(probe).toMatchObject({ ok: false, needsCredentials: false });
      expect(probe.error).toMatch(/127\.0\.0\.2 answered 403 Forbidden/);
      expect(probe.error).not.toMatch(notCredentials);
      expect(probe.error).toMatch(/If this server needs an API key, enter it and test again/);

      const withKey = await servers.probe({
        address: 'http://127.0.0.2:11434',
        credential: { type: 'bearer', token: TOKEN },
      });
      expect(withKey).toMatchObject({ ok: false, needsCredentials: false });
      expect(withKey.error).not.toMatch(/needs an API key/);
    });

    it('marks a saved server with a credential refused on a check and a picker refresh', async () => {
      const fake = fakeOllama();
      fake.state.wantToken = TOKEN;
      const { registry: servers } = registry(fake);
      await servers.add({
        address: 'http://127.0.0.2:11434',
        credential: { type: 'bearer', token: TOKEN },
        name: 'gpu box',
        kind: 'ollama',
        access: 'chat',
      });
      fake.state.forbidden = true;
      const [model] = await servers.models();
      const refreshed = (await servers.views())[1];
      expect(refreshed.health.state).toBe('refused');
      expect(refreshed.health.error).toMatch(/gpu box answered 403 Forbidden/);
      expect(refreshed.health.error).not.toMatch(notCredentials);
      expect(model.unavailable).toMatch(/gpu box was refused/);

      const [, checked] = await servers.check();
      expect(checked.health.state).toBe('refused');
      expect(checked.health.error).toMatch(/gpu box answered 403 Forbidden/);
      expect(checked.health.error).not.toMatch(notCredentials);
    });

    it('turns a 403 mid-chat into a refusal, not a request for new credentials', async () => {
      const fake = fakeOllama();
      const { registry: servers } = registry(fake);
      await servers.add({
        address: 'http://127.0.0.2:11434',
        credential: none,
        name: 'gpu box',
        kind: 'ollama',
        access: 'chat',
      });
      const [, saved] = await servers.views();
      fake.state.forbidden = true;
      const error = await servers
        .chatFor(`srv-${saved.id}`)!
        .stream(
          { model: `local:srv-${saved.id}:qwen2.5:0.5b`, messages: [{ role: 'user', content: 'hi' }] },
          () => undefined
        )
        .catch((err: unknown) => err);
      expect(error).not.toBeInstanceOf(ServerCredentialsError);
      expect((error as Error).message).toMatch(/gpu box answered 403 Forbidden/);
      expect((await servers.views())[1].health.state).toBe('refused');
    });
  });

  it('says a server was edited on add, save and remove, but not when only its health changes', async () => {
    const fake = fakeOllama();
    const { registry: servers, changed, edited } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'a',
      kind: 'ollama',
      access: 'chat',
    });
    const id = (await servers.views())[1].id;
    expect(edited).toHaveBeenCalledTimes(1);
    fake.state.down.add('http://127.0.0.2:11434');
    changed.mockClear();
    await servers.check(id);
    await waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
    expect(edited).toHaveBeenCalledTimes(1);
    await servers.update(id, { name: 'b' });
    expect(edited).toHaveBeenCalledTimes(2);
    await servers.remove(id);
    expect(edited).toHaveBeenCalledTimes(3);
  });

  it('caches no model list read during which a server turned its tools back on', async () => {
    let refuseTools = true;
    const fetchFor = (): FetchLike => async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/models') return json({ data: [{ id: 'm', owned_by: 'vllm' }] });
      if (path === '/v1/chat/completions')
        return refuseTools ? json({ error: '"auto" tool choice requires --enable-auto-tool-choice' }, 400) : json({});
      return json({ error: 'not found' }, 404);
    };
    const holder: { catalog?: ModelCatalog } = {};
    const servers = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store: new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined }),
      logger: { debug: () => undefined, warn: () => undefined },
      changed: () => holder.catalog?.expireLocal(),
      edited: () => holder.catalog?.forgetLocal(),
      fetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
    });
    let computerGate = Promise.resolve();
    const computer = { models: async () => computerGate.then(() => []) };
    const catalog = new ModelCatalog(
      {
        logger: { debug: () => undefined, warn: () => undefined },
        getApiClient: () => null,
        getEnvironmentUrl: () => '',
      },
      new LocalModels(computer as unknown as OllamaLocal, servers)
    );
    holder.catalog = catalog;
    await servers.add({
      address: 'http://192.168.1.20:8000',
      credential: none,
      name: 'gpu vllm',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const view = async () => (await servers.views())[1];
    await waitFor(async () => expect((await view()).toolsHint).toMatch(/without tool calling/), { timeout: 5_000 });
    const serverRows = vi.spyOn(servers, 'models');

    let release = () => {};
    computerGate = new Promise(resolve => (release = resolve));
    const read = catalog.listLocal(true);
    await waitFor(() => expect(serverRows).toHaveBeenCalled(), { timeout: 5_000 });
    expect((await serverRows.mock.results[0].value)[0].supportsTools).toBe(false);
    refuseTools = false;
    await servers.check((await view()).id);
    await waitFor(async () => expect((await view()).toolsHint).toBeUndefined(), { timeout: 5_000 });
    release();
    await read;

    expect(catalog.lastLocal()).toBeNull();
    expect((await catalog.listLocal())[0]).not.toHaveProperty('supportsTools');
  });

  it('keys models by server so two servers can offer the same model', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'one',
      kind: 'ollama',
      access: 'chat',
    });
    await servers.add({
      address: 'http://127.0.0.3:11434',
      credential: none,
      name: 'two',
      kind: 'ollama',
      access: 'chat',
    });
    const [, one, two] = await servers.views();
    const models = await servers.models();
    expect(models.map(model => model.id).sort()).toEqual(
      [`local:srv-${one.id}:qwen2.5:0.5b`, `local:srv-${two.id}:qwen2.5:0.5b`].sort()
    );
    expect(models.find(model => model.server?.name === 'two')?.id).toBe(`local:srv-${two.id}:qwen2.5:0.5b`);
    expect(models.every(model => !model.unavailable)).toBe(true);
  });

  it('keeps an unreachable server listed with its models disabled and named', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    fake.state.down.add('http://127.0.0.2:11434');
    await servers.check();
    const [model] = await servers.models();
    expect(model).toMatchObject({ name: 'qwen2.5:0.5b', server: { name: 'gpu box' } });
    expect(model.unavailable).toMatch(/gpu box is unreachable/);
    expect((await servers.views())[1].health.state).toBe('unreachable');
  });

  describe('a server slow to list its models', () => {
    const SLOW = 'http://127.0.0.2:11434';
    const FAST = 'http://127.0.0.3:11434';

    /** Two servers listed once, so each has saved names; then the next listing on SLOW waits for `release`. */
    async function slowAndFast() {
      const names = ['qwen2.5:0.5b'];
      const fake = fakeOllama(names);
      const { registry: servers, listedLate, changed } = registry(fake);
      await servers.add({ address: SLOW, credential: none, name: 'slow', kind: 'ollama', access: 'chat' });
      await servers.add({ address: FAST, credential: none, name: 'fast', kind: 'ollama', access: 'chat' });
      await servers.models();
      const slowId = (await servers.views())[1].id;
      names.push('llama3.2:3b');
      let release: () => void = () => {};
      let fail: (err: Error) => void = () => {};
      fake.state.tagsGates.set(
        SLOW,
        new Promise<void>((resolve, reject) => {
          release = resolve;
          fail = reject;
        })
      );
      const listedBefore = tagCalls(fake, SLOW);
      return {
        fake,
        names,
        servers,
        listedLate,
        changed,
        slowId,
        listedBefore,
        release: () => release(),
        fail: (err: Error = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })) => fail(err),
      };
    }

    function tagCalls(fake: ReturnType<typeof fakeOllama>, origin: string): number {
      return fake.calls.filter(call => call.origin === origin && call.path === '/api/tags').length;
    }

    /** Lists with fake timers past the wait; the listing on SLOW is still held. */
    async function listPastTheWait(servers: ModelServerRegistry): Promise<ChatModelOption[]> {
      vi.useFakeTimers();
      try {
        let listed: ChatModelOption[] | null = null;
        void servers.models().then(result => {
          listed = result;
        });
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        if (!listed) throw new Error('models() still waiting after the wait');
        return listed;
      } finally {
        vi.useRealTimers();
      }
    }

    const settle = () => new Promise(resolve => setTimeout(resolve, 0));

    it('shows its saved names, disabled, while the fast server lists as usual', async () => {
      const { servers, listedLate, release } = await slowAndFast();
      const listed = await listPastTheWait(servers);
      expect(listed.filter(model => model.server?.name === 'slow')).toEqual([
        expect.objectContaining({
          name: 'qwen2.5:0.5b',
          unavailable: 'slow is still listing its models',
          pending: true,
        }),
      ]);
      const fast = listed.filter(model => model.server?.name === 'fast');
      expect(fast.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(fast.every(model => model.unavailable === undefined)).toBe(true);
      expect(listedLate).not.toHaveBeenCalled();
      release();
    });

    it('says once when the slow list lands, and the next listing returns it without asking again', async () => {
      const { fake, servers, listedLate, slowId, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      await listPastTheWait(servers);
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1);

      release();
      await settle();
      await settle();
      expect(listedLate).toHaveBeenCalledTimes(1);
      expect(listedLate).toHaveBeenCalledWith(slowId);

      const next = await servers.models();
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1);
      const slow = next.filter(model => model.server?.name === 'slow');
      expect(slow.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      expect(listedLate).toHaveBeenCalledTimes(1);
    });

    it('waits for a listing that finishes in time, as before', async () => {
      const { fake, servers, listedLate, listedBefore, release } = await slowAndFast();
      setTimeout(release, 20);
      const listed = await servers.models();
      expect(listed.filter(model => model.server?.name === 'slow').every(model => !model.unavailable)).toBe(true);
      expect(listed).toHaveLength(4);
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1);
      await settle();
      expect(listedLate).not.toHaveBeenCalled();
    });

    it('shows a listing that fails in time as unreachable, as before, and reports nothing', async () => {
      const { fake, servers, listedLate, release } = await slowAndFast();
      fake.state.tagsGates.clear();
      fake.state.down.add(SLOW);
      const listed = await servers.models();
      expect(listed.filter(model => model.server?.name === 'slow')).toEqual([
        expect.objectContaining({ name: 'qwen2.5:0.5b', unavailable: expect.stringMatching(/slow is unreachable/) }),
      ]);
      expect((await servers.views())[1].health.state).toBe('unreachable');
      expect(listedLate).not.toHaveBeenCalled();
      expect(listed.some(model => model.pending)).toBe(false);
      release();
    });

    it('asks the server again once the late listing is older than the freshness window', async () => {
      const { fake, servers, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      release();
      await settle();
      await settle();
      vi.useFakeTimers({ now: Date.now() + LISTED_FRESH_MS });
      try {
        await servers.models();
      } finally {
        vi.useRealTimers();
      }
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
    });

    it('does not list again on a health check while the kept listing is fresh', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      release();
      await settle();
      await servers.check(slowId);
      // The probe's own /api/tags only.
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
      const slow = (await servers.models()).filter(model => model.server?.name === 'slow');
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
      expect(slow).toHaveLength(2);
      expect(slow.every(model => model.unavailable === undefined)).toBe(true);
    });

    it('asks the server again on a health check once the kept listing is stale', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      release();
      await settle();
      vi.useFakeTimers({ now: Date.now() + LISTED_FRESH_MS });
      try {
        await servers.check(slowId);
      } finally {
        vi.useRealTimers();
      }
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 3);
    });

    it('shares a running listing between a health check and the picker', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      const listing = servers.models();
      const checking = servers.check(slowId);
      release();
      await Promise.all([listing, checking]);
      // The check's own probe asks /api/tags once; the model listing after it is the picker's, shared.
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
    });

    it('has the picker list again on removing a server, and not when its abandoned listing lands', async () => {
      const { servers, listedLate, slowId, release } = await slowAndFast();
      await listPastTheWait(servers);
      await servers.remove(slowId);
      expect(listedLate).toHaveBeenCalledExactlyOnceWith(slowId);
      release();
      await settle();
      await settle();
      expect(listedLate).toHaveBeenCalledTimes(1);
    });

    it('has the picker list again when a failed removal dropped a pending listing and that one fails', async () => {
      const { servers, listedLate, slowId, fail } = await slowAndFast();
      await listPastTheWait(servers);
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      expect(listedLate).not.toHaveBeenCalled();
      fail();
      await settle();
      await settle();
      expect(listedLate).toHaveBeenCalledExactlyOnceWith(slowId);
      expect((await servers.views())[1].health.state).toBe('online');
    });

    it('waits out only the listing of the server a turn runs on', async () => {
      const { fake, servers, slowId, release } = await slowAndFast();
      let releaseFast = () => {};
      fake.state.tagsGates.set(FAST, new Promise<void>(resolve => (releaseFast = resolve)));
      const read: { rows?: ChatModelOption[] } = {};
      vi.useFakeTimers();
      try {
        void servers.models({ untilListed: slowId }).then(rows => (read.rows = rows));
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        expect(read.rows).toBeUndefined();
        release();
        await waitFor(() => expect(read.rows).toBeDefined(), { timeout: 5_000 });
      } finally {
        vi.useRealTimers();
        releaseFast();
      }
      const slow = read.rows?.filter(model => model.server?.id === slowId) ?? [];
      expect(slow.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      const fast = read.rows?.filter(model => model.server?.name === 'fast') ?? [];
      expect(fast.length).toBeGreaterThan(0);
      expect(fast.every(model => model.pending)).toBe(true);
    });

    it('has a turn follow the listing started after a pull or removal dropped the one it waited on', async () => {
      const { fake, servers, slowId, listedBefore, fail } = await slowAndFast();
      const read = servers.models({ untilListed: slowId });
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      fake.state.tagsGates.delete(SLOW);
      fail();
      const slow = (await read).filter(model => model.server?.id === slowId);
      expect(slow.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      expect((await servers.views())[1].health.state).toBe('online');
    });

    it('has the picker list again when a pull or removal dropped the listing it waited on, and that one failed', async () => {
      const { fake, servers, slowId, listedBefore, fail } = await slowAndFast();
      const read = servers.models();
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      fake.state.tagsGates.delete(SLOW);
      fail();
      const slow = (await read).filter(model => model.server?.id === slowId);
      expect(slow.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      expect((await servers.views())[1].health.state).toBe('online');
    });

    it('has the picker list a server renamed while its listing was pending, once that listing lands', async () => {
      const { servers, listedLate, slowId, release } = await slowAndFast();
      await listPastTheWait(servers);
      await servers.update(slowId, { name: 'renamed' });
      release();
      await settle();
      await settle();
      expect(listedLate).toHaveBeenCalledWith(slowId);
      const renamed = (await servers.models()).filter(model => model.server?.id === slowId);
      expect(renamed.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(renamed.every(model => model.unavailable === undefined && model.server?.name === 'renamed')).toBe(true);
    });

    it('lists a server again once its tools changed, instead of serving the listing it kept', async () => {
      let listGate = Promise.resolve();
      let listings = 0;
      const fetchFor = (): FetchLike => async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/models') {
          listings += 1;
          await listGate;
          return json({ data: [{ id: 'm', owned_by: 'llamacpp' }] });
        }
        if (path !== '/v1/chat/completions') return json({ error: 'not found' }, 404);
        if ((JSON.parse(String(init?.body)) as { tools?: unknown }).tools)
          return new Response('{"error":{"message":"tools param requires --jinja flag"}}', { status: 500 });
        const reply = { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        return new Response(`data: ${JSON.stringify(reply)}\n\ndata: [DONE]\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      };
      const { registry: servers } = registry({ fetchFor } as unknown as ReturnType<typeof fakeOllama>);
      await servers.add({
        address: 'http://192.168.1.20:8080',
        credential: none,
        name: 'llama',
        kind: 'openai-compatible',
        access: 'chat',
      });
      const id = (await servers.views())[1].id;
      let release = () => {};
      listGate = new Promise(resolve => (release = resolve));
      await listPastTheWait(servers);
      release();
      await settle();
      await settle();
      const kept = listings;
      expect((await servers.models())[0]).not.toHaveProperty('supportsTools');
      expect(listings).toBe(kept);

      await servers.chatFor(`srv-${id}`)?.stream(
        {
          model: `local:srv-${id}:m`,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [{ toolSchema: { name: 'read_file', parameters: { type: 'object' } } }],
        },
        () => undefined
      );
      expect((await servers.models())[0].supportsTools).toBe(false);
      expect(listings).toBe(kept + 1);
    });

    it.each([
      [5_000, 6_000],
      [5_000, 12_000],
    ])(
      'settles when two servers list in %ims and %ims and each late listing reloads the list',
      async (first, second) => {
        const fake = fakeOllama(['qwen2.5:0.5b']);
        const { registry: servers, listedLate } = registry(fake);
        await servers.add({ address: SLOW, credential: none, name: 'a', kind: 'ollama', access: 'chat' });
        await servers.add({ address: FAST, credential: none, name: 'b', kind: 'ollama', access: 'chat' });
        await servers.models();
        const before = [tagCalls(fake, SLOW), tagCalls(fake, FAST)];
        fake.state.tagsDelays.set(SLOW, first);
        fake.state.tagsDelays.set(FAST, second);
        let latest: ChatModelOption[] = [];
        listedLate.mockImplementation(() => void servers.models().then(result => (latest = result)));
        vi.useFakeTimers();
        try {
          void servers.models().then(result => (latest = result));
          await vi.advanceTimersByTimeAsync(60_000);
        } finally {
          vi.useRealTimers();
        }
        expect([tagCalls(fake, SLOW), tagCalls(fake, FAST)]).toEqual([before[0] + 1, before[1] + 1]);
        expect(listedLate).toHaveBeenCalledTimes(2);
        expect(latest).toHaveLength(2);
        expect(latest.every(model => model.unavailable === undefined)).toBe(true);
      }
    );

    it('lists three slow servers once each and never takes a listed server back to pending', async () => {
      const MID = 'http://127.0.0.4:11434';
      const fake = fakeOllama(['qwen2.5:0.5b']);
      const { registry: servers, listedLate } = registry(fake);
      await servers.add({ address: SLOW, credential: none, name: 'a', kind: 'ollama', access: 'chat' });
      await servers.add({ address: MID, credential: none, name: 'c', kind: 'ollama', access: 'chat' });
      await servers.add({ address: FAST, credential: none, name: 'b', kind: 'ollama', access: 'chat' });
      await servers.models();
      const origins = [SLOW, MID, FAST];
      const before = origins.map(origin => tagCalls(fake, origin));
      fake.state.tagsDelays.set(SLOW, 4_000);
      fake.state.tagsDelays.set(MID, 5_000);
      fake.state.tagsDelays.set(FAST, 9_000);
      const results: ChatModelOption[][] = [];
      const list = () => void servers.models().then(result => results.push(result));
      listedLate.mockImplementation(list);
      vi.useFakeTimers();
      try {
        list();
        await vi.advanceTimersByTimeAsync(60_000);
      } finally {
        vi.useRealTimers();
      }
      expect(origins.map(origin => tagCalls(fake, origin))).toEqual(before.map(count => count + 1));
      expect(listedLate).toHaveBeenCalledTimes(3);
      for (const name of ['a', 'b', 'c']) {
        const states = results.map(result => result.find(model => model.server?.name === name)?.pending === true);
        expect(states.indexOf(false)).toBeGreaterThan(-1);
        expect(states.slice(states.indexOf(false))).not.toContain(true);
      }
      expect(results.at(-1)?.every(model => model.unavailable === undefined)).toBe(true);
    });

    /** models() under fake timers, resolved without letting any timer run. */
    async function listWithoutWaiting(servers: ModelServerRegistry): Promise<ChatModelOption[] | null> {
      vi.useFakeTimers();
      try {
        let listed: ChatModelOption[] | null = null;
        void servers.models().then(result => {
          listed = result;
        });
        await vi.advanceTimersByTimeAsync(0);
        return listed;
      } finally {
        vi.useRealTimers();
      }
    }

    it('answers at once with pending rows once a listing was reported, and announces it once', async () => {
      const { fake, servers, listedLate, slowId, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      const again = await listWithoutWaiting(servers);
      expect(again?.filter(model => model.server?.name === 'slow')).toEqual([
        expect.objectContaining({ name: 'qwen2.5:0.5b', pending: true }),
      ]);
      release();
      await settle();
      expect(listedLate).toHaveBeenCalledTimes(1);
      expect(listedLate).toHaveBeenCalledWith(slowId);
      await servers.models();
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1);
    });

    it('applies a late failure once, reports it once and labels the server down', async () => {
      const { servers, listedLate, changed, slowId, fail } = await slowAndFast();
      await listPastTheWait(servers);
      changed.mockClear();
      fail();
      await settle();
      const health = (await servers.views())[1].health;
      expect(health.state).toBe('unreachable');
      await settle();
      expect((await servers.views())[1].health).toBe(health);
      expect(listedLate).toHaveBeenCalledTimes(1);
      expect(listedLate).toHaveBeenCalledWith(slowId);
      expect(changed).toHaveBeenCalledTimes(1);
      expect((await servers.models()).filter(model => model.server?.name === 'slow')).toEqual([
        expect.objectContaining({ unavailable: expect.stringMatching(/slow is unreachable/) }),
      ]);
    });

    /** Under fake timers: lists past the wait, so slow is reported, then lets its held listing land. */
    async function keepLateListing(servers: ModelServerRegistry, release: () => void): Promise<void> {
      const listing = servers.models();
      await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
      await listing;
      release();
      await vi.advanceTimersByTimeAsync(0);
    }

    function slowRows(listed: ChatModelOption[]): ChatModelOption[] {
      return listed.filter(model => model.server?.name === 'slow');
    }

    it("does not revive an older kept list when another server's late listing lands", async () => {
      const { fake, names, servers, slowId, release } = await slowAndFast();
      vi.useFakeTimers();
      try {
        await keepLateListing(servers, release);
        // Once that is stale, a model pulled outside the app reaches slow through a health check.
        await vi.advanceTimersByTimeAsync(LISTED_FRESH_MS);
        names.push('phi3:mini');
        await servers.check(slowId);
        expect((await servers.views())[1].models).toContain('phi3:mini');

        let releaseFast = () => {};
        fake.state.tagsGates.set(FAST, new Promise<void>(resolve => (releaseFast = resolve)));
        const reporting = servers.models();
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        await reporting;
        releaseFast();
        await vi.advanceTimersByTimeAsync(0);

        const slow = slowRows(await servers.models());
        expect(slow.map(model => model.name)).toContain('phi3:mini');
        expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not revive a kept list after a later reported listing of the same server failed', async () => {
      const { fake, names, servers, slowId, release } = await slowAndFast();
      vi.useFakeTimers();
      try {
        await keepLateListing(servers, release);
        await vi.advanceTimersByTimeAsync(LISTED_FRESH_MS);
        let failSlow: (err: Error) => void = () => {};
        fake.state.tagsGates.set(SLOW, new Promise<void>((_resolve, reject) => (failSlow = reject)));
        const reporting = servers.models();
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        await reporting;
        failSlow(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }));
        await vi.advanceTimersByTimeAsync(0);
        expect((await servers.views())[1].health.state).toBe('unreachable');

        fake.state.tagsGates.delete(SLOW);
        names.push('phi3:mini');
        await servers.check(slowId);
        const slow = slowRows(await servers.models());
        expect(slow.map(model => model.name)).toContain('phi3:mini');
        expect(slow.every(model => model.unavailable === undefined)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('dates a late listing failure it cannot classify, so the next load does not check again at once', async () => {
      const { servers, fail } = await slowAndFast();
      vi.useFakeTimers();
      try {
        const listing = servers.models();
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        await listing;
        await vi.advanceTimersByTimeAsync(20_000);
        fail(new Error('boom'));
        await vi.advanceTimersByTimeAsync(0);
        const health = (await servers.views())[1].health;
        expect(health.state).toBe('unreachable');
        expect(Date.now() - Date.parse(health.checkedAt ?? '')).toBeLessThan(1_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a server online when only a health check's model listing fails", async () => {
      const { fake, servers, slowId } = await slowAndFast();
      const refused = Promise.reject(new Error('boom'));
      refused.catch(() => undefined);
      fake.state.tagsGates.set(SLOW, refused);
      await servers.check(slowId);
      expect((await servers.views())[1].health.state).toBe('online');
    });

    it('labels the server down, not pending, when a check finds it down during the wait', async () => {
      const { fake, servers, listedLate, slowId, release } = await slowAndFast();
      vi.useFakeTimers();
      try {
        const listing = servers.models();
        await vi.advanceTimersByTimeAsync(10);
        fake.state.down.add(SLOW);
        await servers.check(slowId);
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        const listed = await listing;
        expect(listed.filter(model => model.server?.name === 'slow')).toEqual([
          expect.objectContaining({ unavailable: expect.stringMatching(/slow is unreachable/) }),
        ]);
        expect(listed.some(model => model.pending)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
      release();
      await settle();
      expect(listedLate).not.toHaveBeenCalled();
    });

    it('ignores a listing detached by a removal during the wait, even after the wait runs out', async () => {
      const { fake, servers, listedLate, slowId, listedBefore, release } = await slowAndFast();
      vi.useFakeTimers();
      try {
        const listing = servers.models();
        await vi.advanceTimersByTimeAsync(1_000);
        await servers
          .hubServer(slowId)
          ?.runtime.remove('qwen2.5:0.5b')
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
        await listing;
      } finally {
        vi.useRealTimers();
      }
      release();
      await settle();
      expect(listedLate).toHaveBeenCalledExactlyOnceWith(slowId);
      expect((await servers.views())[1].models).toEqual(['qwen2.5:0.5b']);
      await servers.models();
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
    });

    it('lets a detached listing finish without dropping the listing that replaced it', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      const first = servers.models();
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      let releaseSecond: () => void = () => {};
      fake.state.tagsGates.set(SLOW, new Promise<void>(resolve => (releaseSecond = resolve)));
      const second = servers.models();
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2), { timeout: 5_000 });
      release();
      await first;
      const third = servers.models();
      await settle();
      releaseSecond();
      await Promise.all([second, third]);
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
    });

    it('lists nothing for a server removed while a picker waits on its listing', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      const listing = servers.models();
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers.remove(slowId);
      release();
      const listed = await listing;
      expect(listed.filter(model => model.server?.id === slowId)).toEqual([]);
    });

    it('lists a server renamed while a picker waits on its listing as saved', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      const listing = servers.models();
      await waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers.update(slowId, { name: 'renamed' });
      release();
      const renamed = (await listing).filter(model => model.server?.id === slowId);
      expect(renamed.map(model => model.name).sort()).toEqual(['llama3.2:3b', 'qwen2.5:0.5b']);
      expect(renamed.every(model => model.unavailable === undefined && model.server?.name === 'renamed')).toBe(true);
    });

    it('does not keep a listing that started before a removal on the Models screen', async () => {
      const { fake, servers, listedLate, slowId, listedBefore, release } = await slowAndFast();
      await listPastTheWait(servers);
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      release();
      await settle();
      await settle();
      expect(listedLate).toHaveBeenCalledExactlyOnceWith(slowId);
      expect((await servers.views())[1].models).toEqual(['qwen2.5:0.5b']);
      await servers.models();
      expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2);
    });
  });

  describe('the macOS Local Network hint', () => {
    const HINT = /System Settings > Privacy & Security > Local Network/;
    const lan = 'http://192.168.1.20:11434';
    const addLanServer = (servers: ModelServerRegistry) =>
      servers.add({ address: lan, credential: none, name: 'gpu box', kind: 'ollama', access: 'chat' });

    it('adds the hint and logs the code when testing a LAN address fails on macOS', async () => {
      const fake = fakeOllama();
      fake.state.down.add(lan);
      fake.state.downCode = 'EHOSTUNREACH';
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const { registry: servers } = registry(fake, {}, { platform: 'darwin', logger });
      const probe = await servers.probe({ address: '192.168.1.20:11434', credential: none });
      expect(probe.ok).toBe(false);
      expect(probe.error).toMatch(HINT);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('EHOSTUNREACH'));
    });

    it('leaves it off on other platforms, for other codes and for loopback', async () => {
      const fake = fakeOllama();
      fake.state.down.add(lan);
      fake.state.down.add('http://127.0.0.2:11434');
      fake.state.downCode = 'EHOSTUNREACH';
      const linux = registry(fake, {}, { platform: 'linux' }).registry;
      const onLinux = (await linux.probe({ address: '192.168.1.20:11434', credential: none })).error;
      expect(onLinux).toMatch(/no route to the host/);
      expect(onLinux).not.toMatch(HINT);
      const mac = registry(fake, {}, { platform: 'darwin' }).registry;
      const loopback = (await mac.probe({ address: '127.0.0.2:11434', credential: none })).error;
      expect(loopback).toMatch(/no route to the host/);
      expect(loopback).not.toMatch(HINT);
      fake.state.downCode = 'ECONNREFUSED';
      const refused = (await mac.probe({ address: '192.168.1.20:11434', credential: none })).error;
      expect(refused).toMatch(/connection refused/);
      expect(refused).not.toMatch(HINT);
    });

    it('shows it when listing the models of a LAN server that went down', async () => {
      const fake = fakeOllama();
      const { registry: servers } = registry(fake, {}, { platform: 'darwin' });
      await addLanServer(servers);
      fake.state.down.add(lan);
      fake.state.downCode = 'EHOSTUNREACH';
      await servers.models();
      const [, saved] = await servers.views();
      expect(saved.health.error).toMatch(HINT);
    });

    it('shows it on a saved LAN server that goes down, and in the chat error', async () => {
      const fake = fakeOllama();
      const { registry: servers } = registry(fake, {}, { platform: 'darwin' });
      await addLanServer(servers);
      fake.state.down.add(lan);
      fake.state.downCode = 'EHOSTUNREACH';
      await servers.check();
      const [, saved] = await servers.views();
      expect(saved.health.error).toMatch(HINT);
      const error = await servers
        .chatFor(`srv-${saved.id}`)!
        .stream(
          { model: `local:srv-${saved.id}:qwen2.5:0.5b`, messages: [{ role: 'user', content: 'hi' }] },
          () => undefined
        )
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ServerUnreachableError);
      expect((error as Error).message).toMatch(HINT);
    });
  });

  it('lists an online server without waiting on a slow health check of it', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    let release: () => void = () => {};
    fake.state.versionGate = new Promise(resolve => (release = resolve));
    const checking = servers.check();
    const listed = await listedAfter(servers, 10);
    release();
    await checking;
    expect(listed).toMatchObject([{ name: 'qwen2.5:0.5b', server: { name: 'gpu box' } }]);
  });

  it('gives up on a host name lookup that does not answer', async () => {
    vi.useFakeTimers();
    try {
      const { registry: servers } = registry(fakeOllama(), () => new Promise(() => {}));
      let probe: ModelServerProbeResult | null = null;
      void servers.probe({ address: 'http://slow.example.test:11434', credential: none }).then(result => {
        probe = result;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probe).toMatchObject({ ok: false, error: expect.stringMatching(/Could not find slow\.example\.test/) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists a server not checked yet without waiting on its first check', async () => {
    const fake = fakeOllama();
    const { registry: servers, store } = registry(fake, () => new Promise(() => {}));
    await store.add(
      {
        name: 'gpu box',
        kind: 'ollama',
        transport: { type: 'http', baseUrl: 'http://gpu.example.test:11434' },
        access: 'manage',
      },
      none
    );
    void servers.start();
    const listed = await listedAfter(servers, 10);
    servers.stop();
    expect(listed).toEqual([expect.objectContaining({ name: 'qwen2.5:0.5b', server: expect.anything() })]);
    expect(listed?.[0].unavailable).toBeUndefined();
  });

  describe('a server shown as down with a check running', () => {
    it('does not list a server removed while the picker waits on its check', async () => {
      const { fake, servers, release, checking } = await downServer();
      const id = (await servers.views())[1].id;
      const tags = () => fake.calls.filter(call => call.path === '/api/tags').length;
      const before = tags();
      const listing = servers.models();
      await servers.remove(id);
      release();
      expect(await listing).toEqual([]);
      await checking;
      // The running check's probe and its listing; the picker starts none.
      expect(tags()).toBe(before + 2);
    });

    async function downServer() {
      const fake = fakeOllama();
      const { registry: servers } = registry(fake);
      await servers.add({
        address: 'http://127.0.0.2:11434',
        credential: none,
        name: 'gpu box',
        kind: 'ollama',
        access: 'manage',
      });
      fake.state.down.add('http://127.0.0.2:11434');
      await servers.check();
      fake.state.down.clear();
      let release: () => void = () => {};
      fake.state.versionGate = new Promise(resolve => (release = resolve));
      const checking = servers.check();
      return { fake, servers, release, checking };
    }

    it('lists it as soon as that check finds it back', async () => {
      const { servers, release, checking } = await downServer();
      const listing = servers.models();
      setTimeout(release, 20);
      const [model] = await listing;
      await checking;
      expect(model).toMatchObject({ name: 'qwen2.5:0.5b', server: { name: 'gpu box' } });
      expect(model.unavailable).toBeUndefined();
    });

    it.each([
      ['a picker read', false],
      ['a turn on that server', true],
    ])('lists once for %s, using the listing that check made', async (_label, turn) => {
      const { fake, servers, release, checking } = await downServer();
      const id = (await servers.views())[1].id;
      const tags = () => fake.calls.filter(call => call.path === '/api/tags').length;
      const before = tags();
      const listing = servers.models(turn ? { untilListed: id } : {});
      setTimeout(release, 20);
      const [model] = await listing;
      await checking;
      expect(model.unavailable).toBeUndefined();
      // The check's probe and its listing; the read starts none of its own.
      expect(tags()).toBe(before + 2);
    });

    it('lists its last models, disabled, when that check is slow', async () => {
      const { servers, release, checking } = await downServer();
      vi.useFakeTimers();
      try {
        let listed: ChatModelOption[] | null = null;
        void servers.models().then(result => {
          listed = result;
        });
        await vi.advanceTimersByTimeAsync(PICKER_CHECK_WAIT_MS);
        expect(listed).toEqual([
          expect.objectContaining({
            name: 'qwen2.5:0.5b',
            unavailable: expect.stringMatching(/gpu box is unreachable/),
          }),
        ]);
      } finally {
        vi.useRealTimers();
        release();
        await checking;
      }
    });

    it('waits out that check for a turn on that server, however slow', async () => {
      const { servers, release, checking } = await downServer();
      const id = (await servers.views())[1].id;
      vi.useFakeTimers();
      try {
        let listed = null as ChatModelOption[] | null;
        void servers.models({ untilListed: id }).then(result => {
          listed = result;
        });
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS * 2);
        expect(listed).toBeNull();
        release();
        await vi.advanceTimersByTimeAsync(0);
        await waitFor(() => expect(listed).not.toBeNull());
        expect(listed).toEqual([expect.objectContaining({ name: 'qwen2.5:0.5b' })]);
        expect(listed?.[0]?.unavailable).toBeUndefined();
      } finally {
        vi.useRealTimers();
        release();
        await checking;
      }
    });

    it('counts the wait on that check against the wait on the listing it started', async () => {
      const { fake, servers, release, checking } = await downServer();
      let finishListing: () => void = () => {};
      fake.state.tagsGatesAfter.set('http://127.0.0.2:11434', {
        skip: 1,
        gate: new Promise<void>(resolve => (finishListing = resolve)),
      });
      vi.useFakeTimers();
      try {
        let listed: ChatModelOption[] | null = null;
        void servers.models().then(result => {
          listed = result;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        release();
        await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS - 1_000);
        expect(listed).toEqual([
          expect.objectContaining({
            name: 'qwen2.5:0.5b',
            unavailable: 'gpu box is still listing its models',
            pending: true,
          }),
        ]);
      } finally {
        vi.useRealTimers();
        finishListing();
        await checking;
      }
    });
  });

  it('sends the saved credential only through its own server fetch', async () => {
    const fake = fakeOllama();
    fake.state.wantToken = TOKEN;
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: { type: 'bearer', token: TOKEN },
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls.every(call => call.origin === 'http://127.0.0.2:11434')).toBe(true);
    const views = await servers.views();
    expect(JSON.stringify(views)).not.toContain(TOKEN);
  });

  it('turns a 401 mid-chat into a request for new credentials', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const [, saved] = await servers.views();
    fake.state.wantToken = TOKEN;
    const chat = servers.chatFor(`srv-${saved.id}`)!;
    await expect(
      chat.stream(
        { model: `local:srv-${saved.id}:qwen2.5:0.5b`, messages: [{ role: 'user', content: 'hi' }] },
        () => undefined
      )
    ).rejects.toBeInstanceOf(ServerCredentialsError);
    expect((await servers.views())[1].health.state).toBe('credentials');
  });

  it('names the server when a chat cannot reach it', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const [, saved] = await servers.views();
    fake.state.down.add('http://127.0.0.2:11434');
    const error = await servers
      .chatFor(`srv-${saved.id}`)!
      .stream(
        { model: `local:srv-${saved.id}:qwen2.5:0.5b`, messages: [{ role: 'user', content: 'hi' }] },
        () => undefined
      )
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServerUnreachableError);
    expect((error as Error).message).toContain('gpu box');
  });

  it('names the server and marks it down when a Node http socket drops mid-reply', async () => {
    const fake = fakeOllama();
    const dropped = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const fetchFor = (endpoint: ServerEndpoint): FetchLike => {
      const inner = fake.fetchFor(endpoint);
      return async (input, init) => {
        if (new URL(String(input)).pathname !== '/api/chat') return inner(input, init);
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: 'par' }, done: false })}\n`));
            controller.error(dropped);
          },
        });
        return new Response(body, { status: 200 });
      };
    };
    const store = new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined });
    const servers = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store,
      logger: { debug: () => undefined, warn: () => undefined },
      fetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => [],
    });
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const [, saved] = await servers.views();
    const error = await servers
      .chatFor(`srv-${saved.id}`)!
      .stream(
        { model: `local:srv-${saved.id}:qwen2.5:0.5b`, messages: [{ role: 'user', content: 'hi' }] },
        () => undefined
      )
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ServerUnreachableError);
    expect((error as Error).message).toMatch(/gpu box.*connection dropped/);
    expect((await servers.views())[1].health.state).toBe('unreachable');
  });

  it('asks for credentials when an OpenAI-compatible server answers 401 during a picker refresh', async () => {
    let revoked = false;
    const fetchFor = (): FetchLike => async input => {
      if (revoked) return json({ error: 'unauthorized' }, 401);
      if (new URL(String(input)).pathname === '/v1/models') {
        return json({ object: 'list', data: [{ id: 'm1', object: 'model' }] });
      }
      return json({ error: 'not found' }, 404);
    };
    const store = new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined });
    const servers = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store,
      logger: { debug: () => undefined, warn: () => undefined },
      fetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => ['93.184.216.34'],
    });
    await servers.add({
      address: 'https://gpu.example.test',
      credential: { type: 'bearer', token: TOKEN },
      name: 'gpu',
      kind: 'openai-compatible',
      access: 'chat',
      acceptOpen: true,
    });
    revoked = true;
    const [model] = await servers.models();
    const view = (await servers.views())[1];
    expect(view.health.state).toBe('credentials');
    expect(view.health.error).toMatch(/rejected the credentials/);
    expect(model.unavailable).toMatch(/needs new credentials/);
  });

  it('tells a saved credential the server rejects from one that was never saved, on the picker rows', async () => {
    const fake = fakeOllama();
    const { registry: servers } = registry(fake);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: { type: 'bearer', token: TOKEN },
      name: 'keyed',
      kind: 'ollama',
      access: 'chat',
    });
    await servers.add({
      address: 'http://127.0.0.3:11434',
      credential: none,
      name: 'bare',
      kind: 'ollama',
      access: 'chat',
    });
    fake.state.wantToken = 'a-token-the-saved-one-is-not';
    const rows = await servers.models();
    expect(rows.find(row => row.server?.name === 'keyed')).toMatchObject({
      unavailable: expect.stringMatching(/keyed needs new credentials/),
      wantsCredentials: 'rejected',
    });
    expect(rows.find(row => row.server?.name === 'bare')).toMatchObject({
      unavailable: expect.stringMatching(/bare needs new credentials/),
      wantsCredentials: 'missing',
    });
  });

  it('still remembers a model that reasoned before Desktop restarted', async () => {
    const fetchFor = (): FetchLike => async input => {
      if (new URL(String(input)).pathname === '/v1/models')
        return json({ object: 'list', data: [{ id: 'qwen3-8b', object: 'model' }] });
      const frames = [{ choices: [{ delta: { reasoning_content: 'hmm' }, finish_reason: 'stop' }] }];
      return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
    };
    const file = memoryFile();
    const quiet = { debug: () => undefined, warn: () => undefined };
    const open = () =>
      new ModelServerRegistry({
        launchers: inertLaunchers(),
        store: new ModelServerStore(cipher, file, quiet),
        logger: quiet,
        fetchFor,
        localFetch: async () => json({ version: '0.12.0' }),
        resolve: async () => ['93.184.216.34'],
      });
    const first = open();
    await first.add({
      address: 'https://gpu.example.test',
      credential: none,
      name: 'gpu',
      kind: 'openai-compatible',
      access: 'chat',
      acceptOpen: true,
    });
    const [model] = await first.models();
    expect(model?.thinkingToggle).toBeUndefined();
    await first.chatFor(model!.id.split(':')[1]!)!.stream({ model: model!.id, messages: [] }, () => undefined);

    const [relaunched] = await open().models();
    expect(relaunched).toMatchObject({ id: model!.id, thinkingAlwaysOn: true });
    expect(relaunched.thinkingToggle).toBeUndefined();
  });

  describe('credentials on a saved http host name that has not been checked yet', () => {
    const saved = {
      name: 'gpu box',
      kind: 'ollama' as const,
      transport: { type: 'http' as const, baseUrl: 'http://box.example.test:11434' },
      access: 'chat' as const,
    };

    it('accepts them when the name resolves to this computer', async () => {
      const { registry: servers, store } = registry(fakeOllama(), { 'box.example.test': ['127.0.0.1'] });
      const record = await store.add(saved, none);
      await servers.update(record.id, { credential: { type: 'bearer', token: TOKEN } });
      expect(store.headers((await store.get(record.id))!)).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it('refuses them when the name resolves to a private address', async () => {
      const { registry: servers, store } = registry(fakeOllama(), { 'box.example.test': ['192.168.1.5'] });
      const record = await store.add(saved, none);
      await expect(servers.update(record.id, { credential: { type: 'bearer', token: TOKEN } })).rejects.toThrow(
        /only sent over https/
      );
    });
  });

  it('returns no chat client for this computer or a hosted model', () => {
    const { registry: servers } = registry(fakeOllama());
    expect(servers.chatFor('ollama')).toBeNull();
    expect(servers.chatFor('lmstudio')).toBeNull();
  });

  it('forgets a removed server and refuses chats to it', async () => {
    const { registry: servers, changed } = registry(fakeOllama());
    await servers.add({
      address: 'http://192.168.1.20:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    const [saved] = (await servers.views()).slice(1);
    changed.mockClear();
    const views = await servers.remove(saved.id);
    expect(views.map(view => view.name)).toEqual(['This computer']);
    expect(changed).toHaveBeenCalled();
    await expect(servers.chatFor(`srv-${saved.id}`)!.contextTokens('local:x:y')).rejects.toThrow(/was removed/);
  });

  it('sizes llama-server context from /props once the probe has identified it', async () => {
    const asked: string[] = [];
    const fetchFor = (): FetchLike => async input => {
      const path = new URL(String(input)).pathname;
      asked.push(path);
      if (path === '/v1/models') return json({ data: [{ id: 'm', owned_by: 'llamacpp' }] });
      if (path === '/props') return json({ build_info: 'b1', default_generation_settings: { n_ctx: 8192 } });
      return json({ error: 'not found' }, 404);
    };
    const { registry: servers } = registry({ fetchFor } as unknown as ReturnType<typeof fakeOllama>);
    await servers.add({
      address: 'http://192.168.1.20:8080',
      credential: none,
      name: 'llama',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const [saved] = (await servers.views()).slice(1);
    const chat = servers.chatFor(`srv-${saved.id}`)!;
    expect(await chat.contextTokens(`local:srv-${saved.id}:m`)).toBe(8192);
  });

  it('ignores a template that /props names after its server was removed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => (release = resolve));
    let asked = 0;
    const fetchFor = (): FetchLike => async input => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/models') return json({ data: [{ id: 'm', owned_by: 'llamacpp' }] });
      if (url.pathname === '/props' && url.searchParams.has('autoload')) {
        asked++;
        await gate;
        return json({ chat_template: '<|channel|> reasoning_effort', model_path: '/m.gguf' });
      }
      if (url.pathname === '/props') return json({ build_info: 'b1', default_generation_settings: { n_ctx: 8192 } });
      return json({ error: 'not found' }, 404);
    };
    const { registry: servers, changed, edited } = registry({ fetchFor } as unknown as ReturnType<typeof fakeOllama>);
    await servers.add({
      address: 'http://192.168.1.20:8080',
      credential: none,
      name: 'llama',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const [saved] = (await servers.views()).slice(1);
    await servers.models();
    await waitFor(() => expect(asked).toBe(1));
    await servers.remove(saved.id);
    edited.mockClear();
    changed.mockClear();
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(edited).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
  });
});

/** An OpenAI-compatible server listing `models` models owned by `owner`, wanting `token` when one is set. */
interface FakeOpenAI {
  owner: string;
  models?: number;
  token?: string;
}

function openAIAnswer(server: FakeOpenAI, path: string, headers: Record<string, string> | null): Response {
  if (server.token && headers?.authorization !== `Bearer ${server.token}`) {
    return json({ error: { message: 'Invalid API Key', type: 'authentication_error' } }, 401);
  }
  if (path === '/v1/models') {
    return json({
      object: 'list',
      data: Array.from({ length: server.models ?? 1 }, (_, index) => ({
        id: `model-${index}`,
        object: 'model',
        owned_by: server.owner,
      })),
    });
  }
  if (path === '/v1/chat/completions') {
    const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
    const timings = { prompt_n: 4, prompt_ms: 20, predicted_n: 2, predicted_ms: 80 };
    const done = {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      ...(server.owner === 'llamacpp' ? { timings } : {}),
    };
    return new Response(`${chunk('Hello')}${chunk(' over SSH')}data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return json({ error: 'not found' }, 404);
}

describe('ModelServerRegistry SSH servers', () => {
  type Mode = 'up' | 'down' | 'unknown-host-key';
  type FarEnd = Record<number, 'ollama' | FakeOpenAI>;

  /**
   * Each destination answers with the servers `farEnd` puts on its loopback ports, the fake Ollama on 11434 by
   * default, or fails the way ssh does in `modes`. A port with nothing on it fails as ssh's forward does.
   */
  function sshSetup(file: StoreFile = memoryFile(), farEnd: FarEnd = { 11434: 'ollama' }) {
    const fake = fakeOllama();
    const modes: Record<string, Mode> = {};
    const sshCalls: string[] = [];
    const sent: { port: number; path: string; authorization: string | null }[] = [];
    const warnings: string[] = [];
    const sshFetchFor =
      (endpoint: SshEndpoint): FetchLike =>
      async (input, init) => {
        const url = new URL(String(input));
        const port = endpoint.port ?? 11434;
        sshCalls.push(`${endpoint.destination} ${url.pathname}`);
        const headers = endpoint.credentialHeaders?.() ?? null;
        sent.push({ port, path: url.pathname, authorization: headers?.authorization ?? null });
        if (url.origin !== `http://127.0.0.1:${port}`) throw new Error(`${url.origin} is not the forwarded port`);
        const mode = modes[endpoint.destination] ?? 'up';
        if (mode === 'down') {
          throw new TypeError('fetch failed', {
            cause: new SshConnectionError(
              `ssh ${endpoint.destination} failed: ssh: connect to host gpu port 22: Connection refused`
            ),
          });
        }
        if (mode === 'unknown-host-key') {
          throw describeSshFailure('Host key verification failed.\n', 255, endpoint.destination);
        }
        const server = farEnd[port];
        if (!server) {
          throw new TypeError('fetch failed', {
            cause: describeSshFailure(
              'channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n',
              255,
              endpoint.destination,
              'Desktop',
              'linux',
              port
            ),
          });
        }
        if (server !== 'ollama') return openAIAnswer(server, url.pathname, headers);
        return fake.fetchFor({ origin: url.origin, label: endpoint.label, credentialHeaders: () => headers })(
          input,
          init
        );
      };
    const logger = {
      debug: (message: string) => warnings.push(message),
      warn: (message: string) => warnings.push(message),
    };
    const store = new ModelServerStore(cipher, file, logger);
    const instance = new ModelServerRegistry({
      launchers: inertLaunchers(),
      store,
      logger,
      fetchFor: fake.fetchFor,
      sshFetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => [],
    });
    return { registry: instance, store, fake, modes, sshCalls, sent, warnings };
  }

  const addSsh = (servers: ModelServerRegistry, destination = 'me@gpu', name = 'lab') =>
    servers.add({ address: destination, transport: 'ssh', credential: none, name, kind: 'ollama', access: 'chat' });

  const probeSsh = (servers: ModelServerRegistry, extra: Partial<ModelServerProbeInput> = {}) =>
    servers.probe({ address: 'me@gpu', transport: 'ssh', credential: none, ...extra });

  const bearer = (token = TOKEN) => ({ type: 'bearer' as const, token });

  it('adds a server by SSH destination under its own id, as Ollama on 11434 with no credential', async () => {
    const { registry: servers, store, sent } = sshSetup();
    await addSsh(servers, ' me@gpu ');
    const [, lab] = await servers.views();
    expect(lab).toMatchObject({
      transport: 'ssh',
      address: 'me@gpu',
      port: 11434,
      kind: 'ollama',
      auth: { type: 'none' },
      unencrypted: false,
      health: { state: 'online', version: '0.12.0' },
      models: ['qwen2.5:0.5b'],
    });
    expect(lab.id).toMatch(/^[0-9a-f]{12}$/);
    const [record] = await store.list();
    expect(record.transport).toEqual({ type: 'ssh', destination: 'me@gpu', port: 11434 });
    expect(new Set(sent.map(request => request.port))).toEqual(new Set([11434]));
  });

  it('refuses a token for Ollama over SSH, and a header for any server over SSH', async () => {
    const { registry: servers, sent } = sshSetup();
    await expect(
      servers.add({
        address: 'me@gpu',
        transport: 'ssh',
        credential: bearer(),
        name: 'lab',
        kind: 'ollama',
        access: 'chat',
      })
    ).rejects.toThrow('Ollama takes no token over SSH: ssh signs in with your keys.');
    const header = await probeSsh(servers, {
      port: 8080,
      credential: { type: 'header', name: 'x-api-key', value: TOKEN },
    });
    expect(header).toMatchObject({
      ok: false,
      error: 'A server reached over SSH takes a bearer token or nothing: ssh signs in with your keys.',
    });
    expect(sent).toEqual([]);
  });

  describe('finding the servers on the far end', () => {
    it('says what to do when no server answers on the usual ports', async () => {
      const { registry: servers } = sshSetup(memoryFile(), {});
      const result = await probeSsh(servers);
      expect(result).toMatchObject({ ok: false, address: 'me@gpu', suggestedName: 'gpu' });
      expect(result.found).toBeUndefined();
      expect(result.error).toBe(
        'SSH to me@gpu works, but no model server answers on the usual ports there (Ollama 11434, LM Studio 1234, llama-server 8080, vLLM 8000). Start the server on that machine, or enter the port it listens on.'
      );
    });

    it('describes the one server it finds, named after the host', async () => {
      const { registry: servers } = sshSetup(memoryFile(), { 8080: { owner: 'llamacpp', models: 2 } });
      expect(await probeSsh(servers)).toMatchObject({
        ok: true,
        address: 'me@gpu',
        port: 8080,
        kind: 'openai-compatible',
        models: 2,
        needsCredentials: false,
        suggestedName: 'gpu',
        found: [{ port: 8080, kind: 'openai-compatible', product: 'llama-server', models: 2, suggestedName: 'gpu' }],
        error: null,
      });
    });

    it('lists several servers with names that stay apart, and sends no token while looking', async () => {
      const { registry: servers, sent } = sshSetup(memoryFile(), {
        11434: 'ollama',
        8080: { owner: 'llama-swap', models: 40 },
        8000: { owner: 'vllm', token: TOKEN },
      });
      const result = await probeSsh(servers);
      expect(result).toMatchObject({ ok: true, kind: null, needsCredentials: true, error: null });
      expect(result.port).toBeUndefined();
      expect(result.found?.map(server => [server.port, server.kind, server.product, server.suggestedName])).toEqual([
        [11434, 'ollama', null, 'gpu Ollama'],
        [8080, 'openai-compatible', 'llama-swap', 'gpu llama-swap'],
        [8000, 'openai-compatible', null, 'gpu port 8000'],
      ]);
      expect(result.found?.find(server => server.port === 8000)?.needsCredentials).toBe(true);
      expect(sent.every(request => request.authorization === null)).toBe(true);
    });

    it('does not suggest the name of a saved server it cannot use, which the store would refuse', async () => {
      const file = memoryFile();
      await file.write(
        JSON.stringify({
          version: 1,
          servers: [
            {
              id: 'a1',
              name: 'gpu',
              kind: 'ollama',
              transport: { type: 'ssh', destination: 'me@gpu', port: 0 },
              access: 'chat',
              auth: { type: 'none' },
            },
          ],
        })
      );
      const { registry: servers } = sshSetup(file, { 8080: { owner: 'llamacpp', models: 2 } });
      const result = await probeSsh(servers);
      expect(result.suggestedName).not.toBe('gpu');
      expect(result.found?.[0].suggestedName).toBe(result.suggestedName);
    });

    it('suggests names no saved server or other row has, so every row saves as suggested', async () => {
      const { registry: servers } = sshSetup(memoryFile(), {
        11434: 'ollama',
        8080: { owner: 'llama-swap', models: 2 },
        8000: { owner: 'vllm' },
      });
      for (const [destination, name] of [
        ['me@a', 'gpu'],
        ['me@b', 'GPU Ollama'],
        ['me@c', 'gpu llama-swap'],
        ['me@d', 'gpu llama-swap 8080'],
      ]) {
        await addSsh(servers, destination, name);
      }
      const several = await probeSsh(servers);
      expect(several.found?.map(server => server.suggestedName)).toEqual([
        'gpu Ollama 11434',
        'gpu llama-swap 8080 2',
        'gpu vLLM',
      ]);
      expect((await probeSsh(servers, { port: 8000 })).suggestedName).toBe('gpu 8000');
      for (const server of several.found ?? []) {
        await servers.add({
          address: 'me@gpu',
          transport: 'ssh',
          port: server.port,
          credential: none,
          name: server.suggestedName,
          kind: server.kind,
          access: 'chat',
        });
      }
      expect((await servers.views()).map(view => view.name)).toEqual(
        expect.arrayContaining(['gpu Ollama 11434', 'gpu llama-swap 8080 2', 'gpu vLLM'])
      );
    });

    it('cuts a long host, not what runs there, to the stored length before keeping names apart', async () => {
      const alias = `gpu-${'x'.repeat(68)}`;
      const { registry: servers } = sshSetup(memoryFile(), {
        11434: 'ollama',
        8080: { owner: 'llama-swap' },
        8000: { owner: 'llamacpp' },
      });
      await addSsh(servers, 'me@a', `${alias} Ollama`);
      const result = await probeSsh(servers, { address: `me@${alias}` });
      const names = result.found?.map(server => server.suggestedName) ?? [];
      expect(names).toEqual([
        `${alias.slice(0, 67)} Ollama 11434`,
        `${alias.slice(0, 69)} llama-swap`,
        `${alias.slice(0, 67)} llama-server`,
      ]);
      expect(names.every(name => name.length <= 80)).toBe(true);
      for (const server of result.found ?? []) {
        await servers.add({
          address: `me@${alias}`,
          transport: 'ssh',
          port: server.port,
          credential: none,
          name: server.suggestedName,
          kind: server.kind,
          access: 'chat',
        });
      }
      expect((await servers.views()).map(view => view.name)).toEqual(expect.arrayContaining(names));
    });

    it('stops numbering when a suffix no longer fits, instead of trying the same cut name forever', () => {
      const server = (port: number, kind: 'ollama' | 'openai-compatible') => ({
        port,
        kind,
        product: kind === 'ollama' ? null : ('llama-swap' as const),
        version: null,
        models: null,
        latencyMs: null,
        needsCredentials: false,
      });
      const found = foundServers(
        'me@gpu',
        [server(11434, 'ollama'), server(8080, 'openai-compatible')],
        ['g Ollama', 'Ollama'],
        8
      );
      expect(found.map(row => row.suggestedName)).toEqual(['Ollama', 'llama-s']);
      expect(found.every(row => row.suggestedName.length <= 8)).toBe(true);
    });

    it('looks only at a port the user names', async () => {
      const { registry: servers, sent } = sshSetup(memoryFile(), { 11434: 'ollama', 9001: { owner: 'vllm' } });
      expect(await probeSsh(servers, { port: ' 9001 ' })).toMatchObject({
        ok: true,
        port: 9001,
        kind: 'openai-compatible',
      });
      expect(new Set(sent.map(request => request.port))).toEqual(new Set([9001]));
      const empty = await probeSsh(servers, { port: 9002 });
      expect(empty.error).toBe(
        'SSH to me@gpu works, but nothing answers at 127.0.0.1:9002 there. Start the model server on that machine, or check its port.'
      );
    });

    it('refuses a bad port before running ssh', async () => {
      const { registry: servers, sent } = sshSetup();
      for (const port of ['', '   ', 0, 65_536, '0', 'abc', '8080;id', '-W', '1e3']) {
        expect(await probeSsh(servers, { port }), String(port)).toMatchObject({
          ok: false,
          error: 'Enter the port the server listens on, on that machine: a number from 1 to 65535.',
        });
        await expect(
          servers.add({
            address: 'me@gpu',
            transport: 'ssh',
            port,
            credential: none,
            name: 'x',
            kind: 'ollama',
            access: 'chat',
          })
        ).rejects.toThrow('a number from 1 to 65535');
      }
      expect(sent).toEqual([]);
    });

    it('sends a token only to the port it is for, and says when it is refused', async () => {
      const { registry: servers, sent } = sshSetup(memoryFile(), { 8080: { owner: 'llamacpp', token: TOKEN } });
      expect(await probeSsh(servers, { credential: bearer() })).toMatchObject({
        ok: false,
        error: 'Enter the port of the server this token is for, then test again.',
      });
      expect(sent).toEqual([]);
      const without = await probeSsh(servers, { port: 8080 });
      expect(without).toMatchObject({ ok: false, needsCredentials: true, port: 8080 });
      expect(without.error).toBe(
        'The server at 127.0.0.1:8080 on me@gpu asks for an API key. Enter it as a token, then test again.'
      );
      const wrong = await probeSsh(servers, { port: 8080, credential: bearer('tok-wrong-zz') });
      expect(wrong).toMatchObject({
        ok: false,
        needsCredentials: true,
        error: 'The server at 127.0.0.1:8080 on me@gpu refused this token.',
      });
      expect(await probeSsh(servers, { port: 8080, credential: bearer() })).toMatchObject({
        ok: true,
        found: [expect.objectContaining({ product: 'llama-server', needsCredentials: false })],
      });
    });
  });

  it('saves an OpenAI-compatible server on its port with its token, and streams a chat over SSH', async () => {
    const { registry: servers, store, sent } = sshSetup(memoryFile(), { 8080: { owner: 'llamacpp', token: TOKEN } });
    await servers.add({
      address: 'me@gpu',
      transport: 'ssh',
      port: '8080',
      credential: bearer(),
      name: 'llama',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const [, llama] = await servers.views();
    expect(llama).toMatchObject({
      transport: 'ssh',
      address: 'me@gpu',
      port: 8080,
      kind: 'openai-compatible',
      auth: { type: 'bearer' },
      health: { state: 'online' },
      models: ['model-0'],
    });
    expect(JSON.stringify(llama)).not.toContain(TOKEN);
    expect((await store.list())[0].transport).toEqual({ type: 'ssh', destination: 'me@gpu', port: 8080 });
    expect(servers.hubServer(llama.id)?.runtime.baseUrl).toBe('ssh://me@gpu port 8080');

    sent.length = 0;
    const events: unknown[] = [];
    await servers
      .chatFor(`srv-${llama.id}`)!
      .stream({ model: `local:srv-${llama.id}:model-0`, messages: [{ role: 'user', content: 'hi' }] }, event =>
        events.push(event)
      );
    expect(JSON.stringify(events)).toContain('Hello');
    expect(JSON.stringify(events)).toContain(' over SSH');
    // llama-server reports no load, so the reply stats derive its wait from these timings.
    expect(events.at(-1)).toMatchObject({ rate: { evalTokens: 2, evalMs: 80, promptMs: 20, loadReported: false } });
    const chat = sent.filter(request => request.path === '/v1/chat/completions');
    expect(chat.length).toBeGreaterThan(0);
    expect(chat.every(request => request.port === 8080 && request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('lists every model of a server that serves many, over SSH and over an address', async () => {
    const swap = { owner: 'llama-swap', models: 300 };
    const { registry: servers } = sshSetup(memoryFile(), { 8080: swap });
    await servers.add({
      address: 'me@gpu',
      transport: 'ssh',
      port: 8080,
      credential: none,
      name: 'swap',
      kind: 'openai-compatible',
      access: 'chat',
    });
    expect((await servers.models()).filter(model => model.server?.name === 'swap')).toHaveLength(300);

    const fetchFor = (): FetchLike => async input => openAIAnswer(swap, new URL(String(input)).pathname, null);
    const { registry: http } = registry({ fetchFor } as unknown as ReturnType<typeof fakeOllama>);
    await http.add({
      address: 'http://192.168.1.20:8080',
      credential: none,
      name: 'swap',
      kind: 'openai-compatible',
      access: 'chat',
    });
    expect((await http.models()).filter(model => model.server?.name === 'swap')).toHaveLength(300);
  });

  it('refuses to save an OpenAI-compatible server as Ollama, naming the kind to choose', async () => {
    const { registry: servers } = sshSetup(memoryFile(), { 8000: { owner: 'vllm' } });
    await expect(
      servers.add({
        address: 'me@gpu',
        transport: 'ssh',
        port: 8000,
        credential: none,
        name: 'v',
        kind: 'ollama',
        access: 'chat',
      })
    ).rejects.toThrow(
      'me@gpu answers at 127.0.0.1:8000 as an OpenAI-compatible server, not Ollama. Choose OpenAI-compatible, then save again.'
    );
    expect((await servers.views()).length).toBe(1);
  });

  it('loads an SSH server saved before ports as Ollama on 11434', async () => {
    const file = memoryFile();
    await file.write(
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'a1b2c3d4e5f6',
            name: 'old lab',
            kind: 'ollama',
            transport: { type: 'ssh', destination: 'me@gpu' },
            access: 'chat',
            auth: { type: 'none' },
            models: ['qwen2.5:0.5b'],
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    );
    const { registry: servers, sent } = sshSetup(file);
    const [, lab] = await servers.views();
    expect(lab).toMatchObject({ id: 'a1b2c3d4e5f6', name: 'old lab', kind: 'ollama', port: 11434, address: 'me@gpu' });
    await servers.check(lab.id);
    expect((await servers.views())[1].health.state).toBe('online');
    expect(sent.some(request => request.port === 11434 && request.path === '/api/version')).toBe(true);
    await servers.update(lab.id, { name: 'lab' });
    const saved = JSON.parse((await file.read()) as string) as { servers: { transport: unknown }[] };
    expect(saved.servers[0].transport).toEqual({ type: 'ssh', destination: 'me@gpu' });
  });

  it('keeps this computer editable when a broken SSH record uses its reserved id', async () => {
    const file = memoryFile();
    await file.write(
      JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'local',
            name: 'broken',
            kind: 'ollama',
            transport: { type: 'ssh' },
            access: 'chat',
            auth: { type: 'none' },
            models: [],
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      })
    );
    const { registry: servers, store } = sshSetup(file);
    const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    expect((await servers.update('local', { specs }))[0].specs).toEqual(specs);
    await expect(servers.update('local', { launch: { flashAttention: 'on' } })).resolves.toBeDefined();
    expect(await store.localLaunch()).toMatchObject({ flashAttention: 'on' });
  });

  it('shows an SSH server saved with a port or destination it cannot use as refused, and lets it be removed', async () => {
    const file = memoryFile();
    const saved = (id: string, name: string, transport: Record<string, unknown>) => ({
      id,
      name,
      kind: 'openai-compatible',
      transport,
      access: 'chat',
      auth: { type: 'bearer' },
      secret: Buffer.from(`enc:${TOKEN}`).toString('base64'),
      models: ['qwen'],
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    await file.write(
      JSON.stringify({
        version: 1,
        servers: [
          saved('a1', 'typo', { type: 'ssh', destination: 'me@gpu', port: 0 }),
          saved('a2', 'text', { type: 'ssh', destination: 'me@gpu', port: '80 80' }),
          saved('a3', 'hostile', { type: 'ssh', destination: '-oProxyCommand=x', port: 8080 }),
          saved('a4', 'other', { type: 'ssh', host: 'gpu' }),
        ],
      })
    );
    const { registry: servers, sshCalls, sent } = sshSetup(file);
    const views = await servers.views();
    expect(views.map(view => view.name)).toEqual(['This computer', 'typo', 'text', 'hostile', 'other']);
    expect(views.map(view => view.unusable)).toEqual([undefined, true, true, true, true]);
    const port = 'Its saved SSH port is not a number from 1 to 65535. Remove this server and add it again.';
    expect(views[1]).toMatchObject({
      id: 'a1',
      kind: 'openai-compatible',
      transport: 'ssh',
      address: 'me@gpu',
      access: 'chat',
      auth: { type: 'bearer' },
      models: [],
      launch: null,
      health: { state: 'refused', error: port },
      unusable: true,
    });
    expect(views[1].port).toBeUndefined();
    expect(views[2].health.error).toBe(port);
    expect(views[3]).toMatchObject({
      address: 'unusable address',
      health: {
        state: 'refused',
        error: 'Its saved SSH destination is not one ssh can be given safely. Remove this server and add it again.',
      },
    });
    expect(views[4]).toMatchObject({
      address: 'unusable address',
      health: { state: 'refused', error: 'It has no saved SSH destination. Remove this server and add it again.' },
    });
    expect(JSON.stringify(views)).not.toContain('ProxyCommand');
    expect(JSON.stringify(views)).not.toContain(TOKEN);
    await servers.check();
    await servers.check('a1');
    expect(await servers.models()).toEqual([]);
    const hub = servers.hubServer('a1');
    expect(await hub?.runtime.health()).toEqual({ ok: false, version: null, error: port });
    await expect(hub?.runtime.list()).rejects.toThrow(port);
    const patches: ModelServerUpdateInput[] = [
      { name: 'fixed' },
      { kind: 'ollama' },
      { access: 'manage' },
      { credential: { type: 'none' } },
      { specs: null },
      { launch: { flashAttention: 'on' } },
      { launch: { kvCacheType: 'q8_0' }, kind: 'ollama' },
    ];
    for (const patch of patches) await expect(servers.update('a1', patch)).rejects.toThrow(port);
    expect(sshCalls).toEqual([]);
    expect(sent).toEqual([]);

    const left = await servers.remove('a1');
    expect(left.map(view => view.name)).toEqual(['This computer', 'text', 'hostile', 'other']);
    const stored = JSON.parse((await file.read()) as string) as { servers: { id: string }[] };
    expect(stored.servers.map(server => server.id)).toEqual(['a2', 'a3', 'a4']);
  });

  it('refuses a destination starting with "-" before running ssh', async () => {
    const { registry: servers, sshCalls } = sshSetup();
    const result = await servers.probe({ address: '-oProxyCommand=touch /tmp/x', transport: 'ssh', credential: none });
    expect(result).toMatchObject({ ok: false, error: 'An SSH destination cannot start with "-".' });
    await expect(addSsh(servers, '-oProxyCommand=x')).rejects.toThrow('cannot start with "-"');
    expect(sshCalls).toEqual([]);
  });

  it('points a user@host typed as an address at the SSH choice', async () => {
    const { registry: servers } = sshSetup();
    const result = await servers.probe({ address: 'me@gpu', credential: none });
    expect(result.error).toBe('This looks like an SSH destination. Choose SSH above, then test again.');
  });

  it('fails closed on an unknown host key with the terminal hint', async () => {
    const { registry: servers, modes } = sshSetup();
    modes['me@gpu'] = 'unknown-host-key';
    const result = await servers.probe({ address: 'me@gpu', transport: 'ssh', credential: none });
    expect(result).toMatchObject({
      ok: false,
      error: "Connect once from a terminal with `ssh me@gpu` to trust this server's host key.",
    });
    await expect(addSsh(servers)).rejects.toThrow('to trust this server');
  });

  it('lists the same model on this computer and the SSH server as two entries, each chatting with its own server', async () => {
    const { registry: servers, sshCalls } = sshSetup();
    await addSsh(servers);
    const [, lab] = await servers.views();
    const computer = {
      models: vi.fn(async (): Promise<ChatModelOption[]> => [
        { id: 'local:ollama:qwen2.5:0.5b', name: 'qwen2.5:0.5b', backend: 'ollama' } as ChatModelOption,
      ]),
      contextFit: vi.fn(),
      stream: vi.fn(async () => undefined),
      contextTokens: vi.fn(async () => 2048),
      growFor: vi.fn(async () => undefined),
    };
    const local = new LocalModels(computer as unknown as OllamaLocal, servers);
    const models = await local.models();
    expect(models.map(model => [model.id, model.server?.name ?? null])).toEqual([
      ['local:ollama:qwen2.5:0.5b', null],
      [`local:srv-${lab.id}:qwen2.5:0.5b`, 'lab'],
    ]);

    sshCalls.length = 0;
    expect(await local.contextTokens(`local:srv-${lab.id}:qwen2.5:0.5b`)).not.toBe(2048);
    expect(sshCalls).toContain('me@gpu /api/show');
    expect(computer.contextTokens).not.toHaveBeenCalled();

    sshCalls.length = 0;
    expect(await local.contextTokens('local:ollama:qwen2.5:0.5b')).toBe(2048);
    expect(sshCalls).toEqual([]);
  });

  it("marks a stopped SSH server's models unavailable without blocking other servers", async () => {
    const { registry: servers, modes } = sshSetup();
    await addSsh(servers);
    await servers.add({
      address: 'http://127.0.0.2:11434',
      credential: none,
      name: 'gpu box',
      kind: 'ollama',
      access: 'chat',
    });
    modes['me@gpu'] = 'down';
    await servers.check();
    const models = await servers.models();
    expect(models.find(model => model.server?.name === 'lab')?.unavailable).toMatch(/lab is unreachable/);
    expect(models.find(model => model.server?.name === 'gpu box')?.unavailable).toBeUndefined();
    const lab = (await servers.views()).find(view => view.name === 'lab');
    expect(lab?.health).toMatchObject({ state: 'unreachable' });
    expect(lab?.health.error).toMatch(/ssh me@gpu failed: .*Connection refused/);
  });

  it('takes a token on an SSH server only while it is OpenAI-compatible', async () => {
    const { registry: servers, sent } = sshSetup();
    await addSsh(servers);
    const [, lab] = await servers.views();
    await expect(servers.update(lab.id, { credential: bearer() })).rejects.toThrow('Ollama takes no token over SSH');
    await expect(
      servers.update(lab.id, { kind: 'openai-compatible', credential: { type: 'header', name: 'x-key', value: TOKEN } })
    ).rejects.toThrow('takes a bearer token or nothing');
    const views = await servers.update(lab.id, { kind: 'openai-compatible', credential: bearer() });
    expect(views[1]).toMatchObject({
      kind: 'openai-compatible',
      auth: { type: 'bearer' },
      transport: 'ssh',
      port: 11434,
    });
    expect(sent.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    await expect(servers.update(lab.id, { kind: 'ollama' })).rejects.toThrow('Remove the token');
    const back = await servers.update(lab.id, { kind: 'ollama', credential: none });
    expect(back[1]).toMatchObject({ kind: 'ollama', auth: { type: 'none' } });
    sent.length = 0;
    await servers.check(lab.id);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(request => request.authorization === null)).toBe(true);
  });

  it('loads a saved SSH server back after a restart', async () => {
    const file = memoryFile();
    await addSsh(sshSetup(file).registry);
    const { registry: restarted, sshCalls } = sshSetup(file);
    const [, lab] = await restarted.views();
    expect(lab).toMatchObject({ name: 'lab', transport: 'ssh', address: 'me@gpu' });
    await restarted.check(lab.id);
    expect(sshCalls).toContain('me@gpu /api/version');
  });
});

describe('ModelServerRegistry launches', () => {
  // Conditions here hold a few promise turns in; vi.waitFor's default 50ms poll would wait each one out.
  // Under fake timers each poll also advances the clock by its interval, so those keep the default.
  const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) =>
    vi.waitFor(check, { ...(vi.isFakeTimers() ? {} : { interval: 1 }), ...options });

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
      expect(registry.runningLocalServerCount()).toBe(0);
      expect((await local(registry)).launch).toMatchObject({ owner: 'none', canStart: true, sizingKvCacheType: 'f16' });

      await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
      expect(registry.localKvCacheType()).toBeUndefined();
      const views = await registry.startServer('local');
      expect(registry.runningLocalServerCount()).toBe(1);
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
      await expect(registry.update('local', { launch: { kvCacheType: 'q4_0' } })).rejects.toThrow(
        'was not started by Bike4Mind Desktop'
      );
    });

    it('saves launch settings for an unmanaged Ollama it cannot read and sizes with them', async () => {
      const { registry, up, launchers } = setup();
      up.add(LOCAL_OLLAMA_URL);
      await registry.check('local');
      expect((await local(registry)).launch).toMatchObject({
        owner: 'other',
        observed: null,
        sizingKvCacheType: 'f16',
      });
      await registry.update('local', { launch: { kvCacheType: 'q8_0' } });
      expect((await local(registry)).launch).toMatchObject({
        owner: 'other',
        settings: { kvCacheType: 'q8_0' },
        sizingKvCacheType: 'q8_0',
        sizingFlashAttention: 'on',
      });
      expect(registry.localKvCacheType()).toBe('q8_0');
      expect(launchers.start).not.toHaveBeenCalled();
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
      const { registry, calls, launchers, handles } = setup();
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
      // A running server's warning shows as its problem, and goes with the server.
      Object.assign(handles[0], { warning: 'runs on the CPU' });
      const view = async () => (await registry.views()).find(server => server.id === added.id)?.launch;
      expect(await view()).toMatchObject({ problem: 'runs on the CPU' });
      (handles[0] as { running: boolean }).running = false;
      expect(await view()).toMatchObject({ problem: null });
      (handles[0] as { running: boolean }).running = true;

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
      await waitFor(async () => expect((await registry.views())[1].launch?.owner).toBe('none'));
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
      vi.mocked(launchers.program).mockResolvedValueOnce({
        problem: 'Desktop could not find Ollama on this computer.',
      });
      await expect(registry.startServer('local')).rejects.toThrow('could not find Ollama');
    });

    it('cannot start an Ollama it cannot find, says why, and looks again later', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockResolvedValueOnce({
          problem: 'Desktop could not find Ollama on this computer.',
        });
        await registry.check('local');
        const missing = (await local(registry)).launch;
        expect(missing).toMatchObject({
          owner: 'none',
          canStart: false,
          problem: null,
          programMissing: 'Desktop could not find Ollama on this computer.',
        });
        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(30_000);
        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(2);
        const found = (await local(registry)).launch;
        expect(found).toMatchObject({ canStart: true, problem: null });
        expect(found?.programMissing).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('looks again at once on a user check, but never runs more than two looks at a time', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockResolvedValueOnce({
          problem: 'Desktop could not find Ollama on this computer.',
        });
        await registry.check('local');
        expect((await local(registry)).launch).toMatchObject({ canStart: false });

        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(2);
        expect((await local(registry)).launch).toMatchObject({ canStart: true });
        await vi.advanceTimersByTimeAsync(2_000);

        let found: (value: { path: string }) => void = () => {};
        vi.mocked(launchers.program)
          .mockReturnValueOnce(new Promise(resolve => (found = resolve)))
          .mockReturnValue(new Promise(() => {}));
        for (let click = 0; click < 4; click++) {
          const checked = registry.check('local', { lookAgain: true });
          await vi.advanceTimersByTimeAsync(2_000);
          await checked;
        }
        expect(launchers.program).toHaveBeenCalledTimes(4);
        found({ path: '/opt/fake/bin' });
        await vi.advanceTimersByTimeAsync(0);
        const last = registry.check('local', { lookAgain: true });
        await vi.advanceTimersByTimeAsync(2_000);
        await last;
        expect(launchers.program).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it('looks again on a user check only two seconds after the last look began', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockResolvedValue({ problem: 'Desktop could not find Ollama on this computer.' });
        await registry.check('local');
        for (let click = 0; click < 10; click++) await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits the whole 30 seconds between looks', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockResolvedValue({ problem: 'Desktop could not find Ollama on this computer.' });
        await registry.check('local');
        await vi.advanceTimersByTimeAsync(29_999);
        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not look again on a user check until two full seconds after the last look began', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockResolvedValue({ problem: 'Desktop could not find Ollama on this computer.' });
        await registry.check('local');
        await vi.advanceTimersByTimeAsync(1_999);
        await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('looks again on a user check even while an earlier look is still stuck, below the outstanding cap', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockReturnValue(new Promise(() => {}));
        const first = registry.check('local');
        await vi.advanceTimersByTimeAsync(2_000);
        await first;
        expect(launchers.program).toHaveBeenCalledTimes(1);
        const second = registry.check('local', { lookAgain: true });
        await vi.advanceTimersByTimeAsync(2_000);
        await second;
        expect(launchers.program).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports a look as pending before the first health check has settled', async () => {
      const { registry } = setup();
      expect((await local(registry)).launch).toMatchObject({ canStart: false, programPending: true });
    });

    it('starts no new look while two abandoned looks are still outstanding', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockReturnValue(new Promise(() => {}));
        for (let round = 0; round < 4; round++) {
          const checked = registry.check('local');
          await vi.advanceTimersByTimeAsync(31_000);
          await checked;
        }
        expect(launchers.program).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops reporting a pending look once two looks are stuck, so Install can show', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockReturnValue(new Promise(() => {}));
        const first = registry.check('local');
        await vi.advanceTimersByTimeAsync(2_000);
        await first;
        expect((await local(registry)).launch).toMatchObject({ canStart: false, programPending: true });

        await vi.advanceTimersByTimeAsync(31_000);
        const second = registry.check('local', { lookAgain: true });
        await vi.advanceTimersByTimeAsync(2_000);
        await second;
        await vi.advanceTimersByTimeAsync(31_000);
        await registry.check('local', { lookAgain: true });
        expect(launchers.program).toHaveBeenCalledTimes(2);
        const launch = (await local(registry)).launch;
        expect(launch).toMatchObject({ canStart: false, problem: null });
        expect(launch?.programPending).toBeUndefined();
        expect(launch?.programMissing).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats a lookup that throws before it returns a promise as a failed look, and keeps looking', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { registry, launchers } = setup();
        vi.mocked(launchers.program).mockImplementation(() => {
          throw new Error('no shell');
        });
        for (let round = 0; round < 3; round++) {
          await expect(registry.check('local')).resolves.toBeDefined();
          await vi.advanceTimersByTimeAsync(31_000);
        }
        expect(launchers.program).toHaveBeenCalledTimes(3);
        const launch = (await local(registry)).launch;
        expect(launch).toMatchObject({
          canStart: false,
          programMissing: 'Desktop could not check for Ollama: no shell',
        });
        expect(launch?.programPending).toBeUndefined();
        await vi.advanceTimersByTimeAsync(0);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        vi.useRealTimers();
      }
    });

    it('reports a look that settles in time with the check, in one push', async () => {
      const { registry, changed } = setup();
      changed.mockClear();
      await registry.check('local');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0][0][0].launch).toMatchObject({ canStart: true });
    });

    it('does not offer Start until it has looked for Ollama, and pushes a slow look once when it settles', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers, changed } = setup();
        let found: (value: { path: string }) => void = () => {};
        vi.mocked(launchers.program).mockReturnValueOnce(new Promise(resolve => (found = resolve)));
        const checked = registry.check('local');
        await vi.advanceTimersByTimeAsync(2_000);
        await checked;
        expect((await local(registry)).launch).toMatchObject({ canStart: false, problem: null, programPending: true });

        await vi.advanceTimersByTimeAsync(0);
        changed.mockClear();
        found({ path: '/opt/fake/bin' });
        await waitFor(() => expect(changed).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(0);
        expect(changed).toHaveBeenCalledTimes(1);
        expect(changed.mock.calls[0][0][0].launch).toMatchObject({ canStart: true });
        expect(changed.mock.calls[0][0][0].launch.programPending).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('drops a look that settles after a newer one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const { registry, launchers } = setup();
        let stale: (value: { problem: string }) => void = () => {};
        vi.mocked(launchers.program).mockReturnValueOnce(new Promise(resolve => (stale = resolve)));
        const first = registry.check('local');
        await vi.advanceTimersByTimeAsync(2_000);
        await first;

        await vi.advanceTimersByTimeAsync(30_000);
        await registry.check('local');
        expect(launchers.program).toHaveBeenCalledTimes(2);
        expect((await local(registry)).launch).toMatchObject({ canStart: true });

        stale({ problem: 'Desktop could not find Ollama on this computer.' });
        await vi.advanceTimersByTimeAsync(0);
        const launch = (await local(registry)).launch;
        expect(launch).toMatchObject({ canStart: true });
        expect(launch?.programMissing).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('never looks for Ollama for a saved loopback address, which may be a tunnel to another machine', async () => {
      const { registry, launchers } = setup();
      const [, added] = await registry.add({
        address: 'http://127.0.0.1:11500',
        credential: none,
        name: 'tunnel',
        kind: 'ollama',
        access: 'chat',
        launch: true,
      });
      vi.mocked(launchers.program).mockClear();
      vi.mocked(launchers.program).mockResolvedValue({ problem: 'Desktop could not find Ollama on this computer.' });
      const views = await registry.check(added.id);
      expect(launchers.program).not.toHaveBeenCalled();
      const view = views.find(server => server.id === added.id)?.launch;
      expect(view).toMatchObject({ canStart: true });
      expect(view?.programMissing).toBeUndefined();
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
      const specs = {
        ramGiB: 64,
        gpuMemoryGiB: null,
        bandwidthGBps: null,
        unified: false,
        kvCacheType: 'q8_0' as const,
      };
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
      await expect(
        registry.update('local', { launch: { kvCacheType: 'q8_0', flashAttention: 'off' } })
      ).rejects.toThrow('needs flash attention');
      await expect(registry.update('local', { launch: { modelsDir: '/m' } })).rejects.toThrow(
        'uses its own models folder'
      );
    });
  });
});

describe('credentials never leak', () => {
  // The `/` and `"` reach the echoing server's JSON escaped, as `\/` and `\"`.
  const BEARER = 'sentinel-bearer/7f3a9c2e41d8';
  const HEADER_NAME = 'x-api-key';
  const HEADER_VALUE = 'sentinel-header"b62d0e95a7c3';
  const SENTINELS = [BEARER, HEADER_VALUE];

  /** Every form a leak could take: the value, its base64, and its unique tail (a masked or cut copy). */
  const LEAK_FORMS = SENTINELS.flatMap(secret => [
    secret,
    Buffer.from(secret).toString('base64'),
    Buffer.from(secret).toString('base64url'),
    secret.slice(-12),
  ]);

  function render(value: unknown): string {
    if (typeof value === 'string') return value;
    const text = inspect(value, {
      depth: Infinity,
      showHidden: true,
      maxArrayLength: Infinity,
      maxStringLength: Infinity,
      breakLength: Infinity,
    });
    return value instanceof Error ? `${String(value)}\n${value.stack ?? ''}\n${text}` : text;
  }

  /** Everything that leaves main for anywhere but the server's own request headers. */
  class Outbound {
    readonly records: { where: string; text: string }[] = [];

    add(where: string, value: unknown): void {
      this.records.push({ where, text: render(value) });
    }

    /** The IPC boundary structured-clones, so a reply that cannot be cloned fails here too. */
    ipc(where: string, value: unknown): void {
      this.add(where, structuredClone(value));
    }

    leaks(): string[] {
      return this.records.flatMap(({ where, text }) =>
        LEAK_FORMS.filter(form => text.includes(form)).map(form => `${where} contains ${form}`)
      );
    }
  }

  // XOR stands in for safeStorage: the file holds bytes that are not the secret in any encoding.
  function xorCipher(keyring: boolean): SecretCipher {
    const flip = (bytes: Uint8Array) => Buffer.from(Uint8Array.from(bytes, byte => byte ^ 0x5a));
    return {
      isEncryptionAvailable: () => keyring,
      encryptString: plain => flip(Buffer.from(plain, 'utf8')),
      decryptString: encrypted => flip(encrypted).toString('utf8'),
    };
  }

  function capturedFile(out: Outbound, saved: string | null): StoreFile & { contents(): string | null } {
    let contents = saved;
    return {
      read: () => Promise.resolve(contents),
      write: next => {
        contents = next;
        out.add('model-servers.json', next);
        return Promise.resolve();
      },
      contents: () => contents,
    };
  }

  type Mode =
    'ok' | 'reject' | 'error' | 'hang' | 'echo-401' | 'echo-500' | 'echo-stream' | 'paused-echo-stream' | 'echo-pull';

  /** A server or proxy that quotes the credential it was sent back in its error, escaping `/` as some encoders do. */
  const echoText = (req: http.IncomingMessage) =>
    `credential ${[req.headers.authorization, req.headers[HEADER_NAME]].filter(Boolean).join(' ')} is not valid here`;
  const echoJson = (value: unknown) => JSON.stringify(value).replaceAll('/', '\\/');

  interface Seen {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
  }

  const servers: http.Server[] = [];

  /** A model server on loopback, where http may carry a credential, that records every request it gets. */
  async function fakeServer(kind: ModelServerKind) {
    const seen: Seen[] = [];
    const state = { mode: 'ok' as Mode };
    const pausedStream = Promise.withResolvers<() => void>();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (state.mode === 'hang') return;
        const send = (status: number, payload: unknown, type = 'application/json') => {
          res.writeHead(status, { 'content-type': type });
          res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
        };
        if (state.mode === 'reject') return send(401, { error: 'unauthorized' });
        if (state.mode === 'error') return send(500, { error: 'the model failed to load' });
        if (state.mode === 'echo-401' || state.mode === 'echo-500') {
          res.writeHead(state.mode === 'echo-401' ? 401 : 500, `Rejected ${echoText(req)}`, {
            'content-type': 'application/json',
          });
          return res.end(echoJson({ error: echoText(req) }));
        }
        const route = `${req.method} ${req.url}`;
        if (
          state.mode === 'paused-echo-stream' &&
          (route === 'POST /api/chat' || route === 'POST /v1/chat/completions')
        ) {
          const isOllama = route === 'POST /api/chat';
          res.writeHead(200, { 'content-type': isOllama ? 'application/x-ndjson' : 'text/event-stream' });
          res.flushHeaders();
          // The caller can rotate or delete the credential after this request used it, before its error arrives.
          pausedStream.resolve(() =>
            res.end(
              isOllama
                ? `${echoJson({ error: echoText(req) })}\n`
                : `data: ${echoJson({ error: { message: echoText(req) } })}\n\n`
            )
          );
          return;
        }
        if (state.mode === 'echo-pull' && route === 'POST /api/pull')
          return send(
            200,
            `${echoJson({ status: echoText(req) })}\n${echoJson({ error: echoText(req) })}\n`,
            'application/x-ndjson'
          );
        if (state.mode === 'echo-stream' && route === 'POST /api/chat')
          return send(200, `${echoJson({ error: echoText(req) })}\n`, 'application/x-ndjson');
        if (state.mode === 'echo-stream' && route === 'POST /v1/chat/completions')
          return send(200, `data: ${echoJson({ error: { message: echoText(req) } })}\n\n`, 'text/event-stream');
        if (kind === 'ollama') {
          if (route === 'GET /api/version') return send(200, { version: '0.12.0' });
          if (route === 'GET /api/tags')
            return send(200, { models: [{ name: 'qwen2.5:0.5b', size: 1, digest: 'd1' }] });
          if (route === 'POST /api/show')
            return send(200, { capabilities: ['completion'], model_info: { 'qwen2.context_length': 4096 } });
          if (route === 'POST /api/chat')
            return send(
              200,
              `${JSON.stringify({ message: { content: 'hello' }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop' })}\n`,
              'application/x-ndjson'
            );
        } else {
          if (route === 'GET /v1/models') return send(200, { object: 'list', data: [{ id: 'm1', object: 'model' }] });
          if (route === 'POST /v1/chat/completions')
            return send(
              200,
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
              'text/event-stream'
            );
        }
        return send(404, { error: 'not found' });
      });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      address: `http://127.0.0.1:${port}`,
      seen,
      state,
      pausedStream: pausedStream.promise,
      close: () => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
      },
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await Promise.all(
      servers.splice(0).map(server => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
      })
    );
  });

  type FakeChild = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

  function exitChild(child: FakeChild, code: number | null, signal: NodeJS.Signals | null = null): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    Object.assign(child, { exitCode: code, signalCode: signal });
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => {
      child.emit('exit', code, signal);
      child.emit('close', code, signal);
    });
  }

  /**
   * The system ssh as createSshFetch runs it: `-W 127.0.0.1:<farPort>` reaches the loopback server at `localPort`, and
   * any other port fails as ssh's forward does. Every command line and environment ssh gets counts as outbound.
   */
  function fakeSsh(out: Outbound, farPort: number, localPort: () => number): SshDeps['spawn'] {
    return (_command, args, options) => {
      out.add('ssh spawn', { args, env: (options as { env?: unknown } | undefined)?.env });
      const child = new EventEmitter() as FakeChild;
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      child.kill = (() => {
        exitChild(child, null, 'SIGTERM');
        return true;
      }) as never;
      if (args[0] === '-G') {
        setImmediate(() => {
          child.stdout.write('user me\n');
          exitChild(child, 0);
        });
        return child;
      }
      if (args[args.indexOf('-W') + 1] !== `127.0.0.1:${farPort}`) {
        setImmediate(() => {
          child.stderr.write('channel 0: open failed: connect failed: Connection refused\nstdio forwarding failed\n');
          exitChild(child, 255);
        });
        return child;
      }
      const socket = net.connect(localPort(), '127.0.0.1');
      child.stdin.pipe(socket);
      socket.on('data', chunk => child.stdout.write(chunk));
      socket.on('end', () => exitChild(child, 0));
      socket.on('error', () => {
        child.stderr.write('channel 0: open failed: connect failed: Connection refused\n');
        exitChild(child, 255);
      });
      child.on('close', () => socket.destroy());
      return child;
    };
  }

  /** main as chat/index.ts wires it, with every exit from main captured. */
  function desktopMain(
    cipher: SecretCipher,
    out = new Outbound(),
    saved: string | null = null,
    sshFetchFor?: (endpoint: SshEndpoint) => ReturnType<typeof createSshFetch>
  ) {
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => out.add(`console.${level}`, args));
    }
    // Anything on the global fetch is not a saved server's request; "This computer" gets no Ollama here.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: unknown) => {
        out.add('global fetch', { input, init });
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
      })
    );
    const logger = {
      debug: (message: string) => out.add('log.debug', message),
      warn: (message: string) => out.add('log.warn', message),
    };
    const file = capturedFile(out, saved);
    const store = new ModelServerStore(cipher, file, logger);
    const registry = new ModelServerRegistry({
      store,
      logger,
      launchers: inertLaunchers(),
      changed: views => out.ipc(`push ${IPC_CHANNELS.modelServersChanged}`, views),
      ...(sshFetchFor ? { sshFetchFor } : {}),
    });
    const local = new LocalModels(new OllamaLocal(), registry);

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, listener);
      },
    } as unknown as Pick<IpcMain, 'handle'>;
    registerModelServersIpc(ipcMain, registry);
    const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      const reply = (await handler({}, ...args)) as T;
      out.ipc(`reply ${channel}`, reply);
      return reply;
    };

    const listModels = async () => out.ipc('reply chat:list-models', await local.models());

    /** A chat turn as ChatService runs it: events go to the renderer, a failure's message to the log, renderer and history. */
    const chat = async (model: string, signal?: AbortSignal) => {
      const events: CompletionStreamEvent[] = [];
      try {
        await local.stream({ model, messages: [{ role: 'user', content: 'hi' }] }, event => events.push(event), signal);
        return { events, error: null };
      } catch (err) {
        out.add('chat error', err);
        return { events, error: err as Error };
      } finally {
        out.ipc('push chat events', events);
      }
    };

    return { out, store, registry, file, invoke, listModels, chat };
  }

  function credential(type: 'bearer' | 'header'): ModelServerCredentialInput {
    return type === 'bearer' ? { type, token: BEARER } : { type, name: HEADER_NAME, value: HEADER_VALUE };
  }

  /** The sentinel may reach the server only as the exact credential header; never in a URL, body or other header. */
  function requestLeaks(seen: Seen[]): string[] {
    return seen.flatMap(request => {
      const where = `${request.method} ${request.url}`;
      const found = LEAK_FORMS.filter(form => request.url.includes(form) || request.body.includes(form)).map(
        form => `${where} url or body contains ${form}`
      );
      for (const [name, value] of Object.entries(request.headers)) {
        const text = String(value);
        const allowed =
          (name === 'authorization' && text === `Bearer ${BEARER}`) || (name === HEADER_NAME && text === HEADER_VALUE);
        if (!allowed) found.push(...LEAK_FORMS.filter(form => text.includes(form)).map(form => `${where} ${name}`));
      }
      return found;
    });
  }

  async function scenario(kind: ModelServerKind, keyring: boolean, first: 'bearer' | 'header') {
    const second = first === 'bearer' ? 'header' : 'bearer';
    const target = await fakeServer(kind);
    const cipher = xorCipher(keyring);
    const main = desktopMain(cipher);
    const { invoke, out } = main;
    await main.registry.start();

    // Entered: a value HTTP refuses is turned away without the value in the message.
    const invalid: ModelServerCredentialInput =
      first === 'bearer'
        ? { type: 'bearer', token: `${BEARER} more` }
        : { type: 'header', name: HEADER_NAME, value: `${HEADER_VALUE}\u0007` };
    const refusedInput = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
      address: target.address,
      credential: invalid,
    });
    expect(refusedInput.ok).toBe(false);
    expect(target.seen).toHaveLength(0);

    target.state.mode = 'reject';
    const rejected = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
      address: target.address,
      credential: credential(first),
    });
    expect(rejected).toMatchObject({ ok: false, needsCredentials: true });

    target.state.mode = 'ok';
    const probe = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
      address: target.address,
      credential: credential(first),
    });
    expect(probe).toMatchObject({ ok: true, kind });

    const added = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
      address: target.address,
      credential: credential(first),
      name: 'gpu box',
      kind,
      access: 'chat',
    });
    if (!added.ok) throw new Error(added.error);
    const saved = added.servers.find(server => !server.local) as ModelServerView;
    expect(saved.health.state).toBe('online');
    const model = `local:srv-${saved.id}:${kind === 'ollama' ? 'qwen2.5:0.5b' : 'm1'}`;

    await invoke(IPC_CHANNELS.modelServersList);
    await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
    await invoke(IPC_CHANNELS.modelServersCheck);
    await main.listModels();
    expect((await main.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });

    // Loaded: Desktop restarts on the saved file. Without a keyring the credential was kept for that run only.
    const restarted = desktopMain(cipher, out, main.file.contents());
    await restarted.registry.start();
    const reloaded = await restarted.invoke<ModelServerView[]>(IPC_CHANNELS.modelServersList);
    expect(reloaded.find(server => server.id === saved.id)?.credentialsMissing).toBe(!keyring);
    const afterRestart = await restarted.chat(model);
    if (keyring) expect(afterRestart.events).toContainEqual({ type: 'content', text: 'hello' });
    else expect(afterRestart.error?.name).toBe('ServerCredentialsError');
    restarted.registry.stop();
    if (keyring) {
      const locked = desktopMain(
        {
          ...cipher,
          decryptString: () => {
            throw new Error('the keyring is locked');
          },
        },
        out,
        main.file.contents()
      );
      expect((await locked.chat(model)).error?.name).toBe('ServerCredentialsError');
      await locked.invoke(IPC_CHANNELS.modelServersCheck, saved.id);
      expect(out.records.some(record => record.where === 'log.warn')).toBe(true);
    }

    // Echoed: the server quotes the credential back in 401 and 500 replies and inside a streamed reply,
    // before and after the edit below.
    const echoes = async (current: 'bearer' | 'header', label: string) => {
      const chatErrors: Record<string, Error | null> = {};
      for (const mode of ['echo-401', 'echo-500', 'echo-stream'] as const) {
        target.state.mode = mode;
        await invoke(IPC_CHANNELS.modelServersProbe, { address: target.address, credential: credential(current) });
        await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
        chatErrors[mode] = (await main.chat(model)).error;
        await main.listModels();
      }
      target.state.mode = 'ok';
      const echoed = 'credential [redacted] is not valid here';
      expect(chatErrors['echo-401']?.name).toBe('ServerCredentialsError');
      expect(chatErrors['echo-500']?.message).toBe(`${label} returned HTTP 500: ${echoed}`);
      expect(chatErrors['echo-stream']?.message).toBe(kind === 'ollama' ? echoed : `${label}: ${echoed}`);
    };
    await echoes(first, 'gpu box');

    // Edited: renamed, then the credential replaced with the other kind.
    await invoke(IPC_CHANNELS.modelServersUpdate, saved.id, { name: 'gpu box 2' });
    const edited = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersUpdate, saved.id, {
      credential: credential(second),
    });
    expect(edited.ok).toBe(true);
    expect((await main.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });
    await echoes(second, 'gpu box 2');

    // Failures: the server refuses the credential, errors, stops answering, then is gone.
    target.state.mode = 'reject';
    await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
    expect((await main.chat(model)).error?.name).toBe('ServerCredentialsError');
    await main.listModels();

    target.state.mode = 'error';
    expect((await main.chat(model)).error?.message).toContain('HTTP 500');

    target.state.mode = 'hang';
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const probeDeadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(50));
    const timedOut = await invoke<ModelServerView[]>(IPC_CHANNELS.modelServersCheck, saved.id);
    probeDeadline.mockRestore();
    expect(timedOut.find(server => server.id === saved.id)?.health.error).toMatch(/did not answer in time/);
    expect((await main.chat(model, AbortSignal.timeout(50))).error).not.toBeNull();

    await target.close();
    const down = await invoke<ModelServerView[]>(IPC_CHANNELS.modelServersCheck, saved.id);
    expect(down.find(server => server.id === saved.id)?.health.error).toMatch(/connection refused/);
    expect((await main.chat(model)).error?.name).toBe('ServerUnreachableError');
    await main.listModels();

    const removed = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersRemove, saved.id);
    if (!removed.ok) throw new Error(removed.error);
    expect(removed.servers.map(server => server.id)).not.toContain(saved.id);
    await main.chat(model);
    main.registry.stop();

    expect(out.leaks()).toEqual([]);
    expect(requestLeaks(target.seen)).toEqual([]);
    // The server did get both credentials, as headers.
    expect(target.seen.some(request => request.headers.authorization === `Bearer ${BEARER}`)).toBe(true);
    expect(target.seen.some(request => request.headers[HEADER_NAME] === HEADER_VALUE)).toBe(true);
    // Removal forgets the secret in main too, and the file never held it.
    expect(SENTINELS.filter(secret => render(main.store).includes(secret))).toEqual([]);
    expect(main.file.contents()).not.toMatch(/"secret"/);
    return out;
  }

  describe('a model server credential never leaves main except in its own request headers', () => {
    describe.each(['ollama', 'openai-compatible'] as const)('%s in-flight credential changes', kind => {
      it.each(['rotate', 'clear', 'remove'] as const)(
        'redacts an old credential after %s while a streamed error is pending',
        async mutation => {
          const target = await fakeServer(kind);
          const main = desktopMain(xorCipher(false));
          await main.registry.start();
          const added = await main.invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
            address: target.address,
            credential: credential('bearer'),
            name: 'gpu box',
            kind,
            access: 'chat',
          });
          if (!added.ok) throw new Error(added.error);
          const saved = added.servers.find(server => !server.local);
          if (!saved) throw new Error('The model server was not saved.');
          const model = `local:srv-${saved.id}:${kind === 'ollama' ? 'qwen2.5:0.5b' : 'm1'}`;

          target.state.mode = 'paused-echo-stream';
          const pendingChat = main.chat(model);
          const releaseError = await target.pausedStream;
          const request = target.seen.at(-1);
          expect(request?.headers.authorization).toBe(`Bearer ${BEARER}`);

          if (mutation === 'remove') {
            await main.store.remove(saved.id);
            expect(await main.store.get(saved.id)).toBeNull();
          } else {
            const updated = await main.store.update(saved.id, {
              credential: mutation === 'rotate' ? credential('header') : { type: 'none' },
            });
            expect(main.store.headers(updated)).toEqual(mutation === 'rotate' ? { [HEADER_NAME]: HEADER_VALUE } : null);
          }
          releaseError();
          const result = await pendingChat;
          main.registry.stop();

          const echoed = 'credential [redacted] is not valid here';
          expect(result.error?.message).toBe(kind === 'ollama' ? echoed : `gpu box: ${echoed}`);
          expect(result.events).toEqual([]);
          expect(main.out.leaks()).toEqual([]);
          expect(requestLeaks(target.seen)).toEqual([]);
        }
      );
    });

    it.each(['bearer', 'header'] as const)('redacts a %s credential echoed into a streamed pull', async type => {
      const target = await fakeServer('ollama');
      const main = desktopMain(xorCipher(true));
      await main.registry.start();
      const added = await main.invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
        address: target.address,
        credential: credential(type),
        name: 'gpu box',
        kind: 'ollama',
        access: 'manage',
      });
      if (!added.ok) throw new Error(added.error);
      const saved = added.servers.find(server => !server.local);
      const hub = saved && main.registry.hubServer(saved.id);
      if (!hub) throw new Error('The model server was not saved.');

      target.state.mode = 'echo-pull';
      const statuses: string[] = [];
      const error = await hub.runtime
        .pull('qwen2.5:0.5b', { onProgress: progress => statuses.push(progress.status) })
        .catch((err: unknown) => err);
      main.out.add('pull error', error);
      main.out.add('pull statuses', statuses);
      main.registry.stop();

      expect((error as Error).message).toMatch(
        /could not pull qwen2\.5:0\.5b: credential \[redacted\] is not valid here$/
      );
      expect(statuses).toEqual(['credential [redacted] is not valid here']);
      expect(target.seen.some(request => request.url === '/api/pull')).toBe(true);
      expect(main.out.leaks()).toEqual([]);
      expect(requestLeaks(target.seen)).toEqual([]);
    });

    it('Ollama with a keyring: bearer token, then a custom header', { timeout: 60_000 }, async () => {
      const out = await scenario('ollama', true, 'bearer');
      expect(
        out.records.some(record => record.where === 'model-servers.json' && record.text.includes('"secret"'))
      ).toBe(true);
    });

    it('OpenAI-compatible over SSH: the bearer token reaches only its own requests', { timeout: 60_000 }, async () => {
      const target = await fakeServer('openai-compatible');
      const out = new Outbound();
      const localPort = () => Number(new URL(target.address).port);
      const sshFetchFor = (endpoint: SshEndpoint) =>
        createSshFetch(endpoint, { spawn: fakeSsh(out, 8080, localPort), platform: 'win32' });
      const cipher = xorCipher(true);
      const main = desktopMain(cipher, out, null, sshFetchFor);
      const { invoke } = main;
      await main.registry.start();
      const ssh = { address: 'me@gpu', transport: 'ssh', port: 8080 };

      const malformed = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
        ...ssh,
        credential: { type: 'bearer', token: `${BEARER} more` },
      });
      expect(malformed.ok).toBe(false);
      const header = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
        ...ssh,
        credential: credential('header'),
      });
      expect(header.error).toMatch(/takes a bearer token or nothing/);
      const anyPort = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
        address: 'me@gpu',
        transport: 'ssh',
        credential: credential('bearer'),
      });
      expect(anyPort.error).toBe('Enter the port of the server this token is for, then test again.');
      expect(target.seen).toHaveLength(0);

      target.state.mode = 'reject';
      const rejected = await invoke<ModelServerProbeResult>(IPC_CHANNELS.modelServersProbe, {
        ...ssh,
        credential: credential('bearer'),
      });
      expect(rejected).toMatchObject({ ok: false, needsCredentials: true });
      expect(rejected.error).toBe('The server at 127.0.0.1:8080 on me@gpu refused this token.');

      target.state.mode = 'ok';
      const added = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersAdd, {
        ...ssh,
        credential: credential('bearer'),
        name: 'gpu box',
        kind: 'openai-compatible',
        access: 'chat',
      });
      if (!added.ok) throw new Error(added.error);
      const saved = added.servers.find(server => !server.local) as ModelServerView;
      expect(saved).toMatchObject({
        transport: 'ssh',
        port: 8080,
        auth: { type: 'bearer' },
        health: { state: 'online' },
      });
      const model = `local:srv-${saved.id}:m1`;
      await main.listModels();
      expect((await main.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });

      const chatErrors: Record<string, Error | null> = {};
      for (const mode of ['echo-401', 'echo-500', 'echo-stream'] as const) {
        target.state.mode = mode;
        await invoke(IPC_CHANNELS.modelServersProbe, { ...ssh, credential: credential('bearer') });
        await invoke(IPC_CHANNELS.modelServersCheck, saved.id);
        chatErrors[mode] = (await main.chat(model)).error;
        await main.listModels();
      }
      target.state.mode = 'ok';
      const echoed = 'credential [redacted] is not valid here';
      expect(chatErrors['echo-401']?.name).toBe('ServerCredentialsError');
      expect(chatErrors['echo-500']?.message).toBe(`gpu box returned HTTP 500: ${echoed}`);
      expect(chatErrors['echo-stream']?.message).toBe(`gpu box: ${echoed}`);

      const restarted = desktopMain(cipher, out, main.file.contents(), sshFetchFor);
      await restarted.registry.start();
      expect((await restarted.chat(model)).events).toContainEqual({ type: 'content', text: 'hello' });
      restarted.registry.stop();

      await target.close();
      const down = await invoke<ModelServerView[]>(IPC_CHANNELS.modelServersCheck, saved.id);
      expect(down.find(server => server.id === saved.id)?.health.error).toMatch(/nothing answers at 127\.0\.0\.1:8080/);
      expect((await main.chat(model)).error).not.toBeNull();
      const removed = await invoke<ModelServerMutationResult>(IPC_CHANNELS.modelServersRemove, saved.id);
      if (!removed.ok) throw new Error(removed.error);
      main.registry.stop();

      expect(out.records.some(record => record.where === 'ssh spawn')).toBe(true);
      expect(out.leaks()).toEqual([]);
      expect(requestLeaks(target.seen)).toEqual([]);
      expect(target.seen.some(request => request.headers.authorization === `Bearer ${BEARER}`)).toBe(true);
      expect(main.file.contents()).not.toMatch(/"secret"/);
    });

    it('OpenAI-compatible without a keyring: custom header, then a bearer token', { timeout: 60_000 }, async () => {
      const out = await scenario('openai-compatible', false, 'header');
      expect(
        out.records.some(record => record.where === 'model-servers.json' && record.text.includes('"secret"'))
      ).toBe(false);
    });
  });
});

describe('ModelServerStore', () => {
  const TOKEN = 'tok-secret-zz';
  const HEADER_VALUE = 'hdr-secret-qq';

  function cipher(available = true): SecretCipher {
    return {
      isEncryptionAvailable: () => available,
      encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
      decryptString: encrypted => encrypted.toString('utf8').replace(/^enc:/, ''),
    };
  }

  function memoryFile(contents: string | null = null): StoreFile & { contents: string | null } {
    return {
      contents,
      read() {
        return Promise.resolve(this.contents);
      },
      write(next: string) {
        this.contents = next;
        return Promise.resolve();
      },
    };
  }

  const logger = { debug: vi.fn(), warn: vi.fn() };
  const base = {
    name: 'gpu box',
    kind: 'ollama' as const,
    transport: { type: 'http' as const, baseUrl: 'https://gpu.example.test' },
    access: 'chat' as const,
  };

  describe('ModelServerStore', () => {
    it('keeps a bearer token only as ciphertext on disk and reads it back after a restart', async () => {
      const file = memoryFile();
      const record = await new ModelServerStore(cipher(), file, logger).add(base, { type: 'bearer', token: TOKEN });
      expect(file.contents).not.toContain(TOKEN);
      expect(JSON.parse(file.contents!).servers[0].secret).toBe(Buffer.from(`enc:${TOKEN}`).toString('base64'));

      const reopened = new ModelServerStore(cipher(), file, logger);
      const [saved] = await reopened.list();
      expect(saved).toMatchObject({ id: record.id, auth: { type: 'bearer' } });
      expect(JSON.stringify(saved)).not.toContain(TOKEN);
      expect(reopened.headers(saved)).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it('stores a custom header name in the clear and its value encrypted', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'header', name: 'X-Api-Key', value: HEADER_VALUE });
      expect(file.contents).toContain('X-Api-Key');
      expect(file.contents).not.toContain(HEADER_VALUE);
      expect(store.headers(record)).toEqual({ 'x-api-key': HEADER_VALUE });
    });

    it('keeps a credential for this run only when the keyring is unavailable', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(false), file, logger);
      const record = await store.add(base, { type: 'bearer', token: TOKEN });
      expect(store.credentialPersisted()).toBe(false);
      expect(file.contents).not.toContain(TOKEN);
      expect(JSON.parse(file.contents!).servers[0].secret).toBeUndefined();
      expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect(store.credentialMissing(record)).toBe(false);

      const restarted = new ModelServerStore(cipher(false), file, logger);
      const [saved] = await restarted.list();
      expect(restarted.headers(saved)).toBeNull();
      expect(restarted.credentialMissing(saved)).toBe(true);
    });

    it('logs a decrypt failure without the ciphertext or the secret', async () => {
      const file = memoryFile();
      await new ModelServerStore(cipher(), file, logger).add(base, { type: 'bearer', token: TOKEN });
      const broken: SecretCipher = {
        ...cipher(),
        decryptString: () => {
          throw new Error(`bad ${TOKEN}`);
        },
      };
      const store = new ModelServerStore(broken, file, logger);
      logger.warn.mockClear();
      logger.debug.mockClear();
      const [saved] = await store.list();
      expect(store.headers(saved)).toBeNull();
      const logged = [...logger.warn.mock.calls, ...logger.debug.mock.calls].flat().join('\n');
      expect(logged).toContain('gpu box');
      expect(logged).not.toContain(TOKEN);
      expect(logged).not.toContain(JSON.parse(file.contents!).servers[0].secret);
    });

    it('drops the old secret when the credential is changed to none', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'bearer', token: TOKEN });
      const updated = await store.update(record.id, { credential: { type: 'none' } });
      expect(updated.auth).toEqual({ type: 'none' });
      expect(store.headers(updated)).toBeNull();
      expect(JSON.parse(file.contents!).servers[0].secret).toBeUndefined();
    });

    it('keeps fields and records a later version wrote when it rewrites the file', async () => {
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          extra: { kept: true },
          servers: [
            { ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' }, contextTokens: 32768 },
            {
              id: 'bbbbbbbbbbbb',
              name: 'ssh box',
              kind: 'ollama',
              transport: { type: 'ssh', host: 'box' },
              access: 'manage',
              auth: { type: 'none' },
            },
            {
              id: 'cccccccccccc',
              name: 'future',
              kind: 'vllm',
              transport: { type: 'http', baseUrl: 'https://f.example.test' },
              access: 'chat',
              auth: { type: 'none' },
            },
          ],
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      expect((await store.list()).map(server => server.id)).toEqual(['aaaaaaaaaaaa']);
      await store.update('aaaaaaaaaaaa', { access: 'manage' });
      const written = JSON.parse(file.contents!);
      expect(written.extra).toEqual({ kept: true });
      expect(written.servers[0]).toMatchObject({ access: 'manage', contextTokens: 32768 });
      expect(written.servers[1].transport).toEqual({ type: 'ssh', host: 'box' });
      expect(written.servers[2].kind).toBe('vllm');
    });

    it('keeps a record without a string id when it rewrites the file', async () => {
      const orphan = { name: 'companion', kind: 'companion' };
      const file = memoryFile(
        JSON.stringify({ version: 1, servers: [{ ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' } }, orphan] })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      await store.update('aaaaaaaaaaaa', { access: 'manage' });
      const written = JSON.parse(file.contents!);
      expect(written.servers).toHaveLength(2);
      expect(written.servers).toContainEqual(orphan);
    });

    it('uses a file from a newer version read-only and never rewrites it', async () => {
      const original = JSON.stringify({
        version: 2,
        servers: [{ ...base, id: 'aaaaaaaaaaaa', auth: { type: 'none' } }],
        thinkers: { aaaaaaaaaaaa: [{ model: 'qwen3-8b' }] },
      });
      const file = memoryFile(original);
      const warn = vi.fn();
      const store = new ModelServerStore(cipher(), file, { debug: vi.fn(), warn });
      expect((await store.list()).map(server => server.id)).toEqual(['aaaaaaaaaaaa']);
      await expect(store.update('aaaaaaaaaaaa', { access: 'manage' })).rejects.toThrow(/newer Desktop/);
      await expect(store.add({ ...base, name: 'other' }, { type: 'none' })).rejects.toThrow(/newer Desktop/);
      await expect(store.remove('aaaaaaaaaaaa')).rejects.toThrow(/newer Desktop/);
      await store.setModels('aaaaaaaaaaaa', ['m1']);
      await store.addThinker('aaaaaaaaaaaa', 'phi-4');
      await store.forgetThinker('aaaaaaaaaaaa', 'qwen3-8b');
      expect(file.contents).toBe(original);
      expect(warn.mock.calls.flat().join('\n')).toMatch(/version 2/);
    });

    it('refuses a duplicate name, including the name of this computer', async () => {
      const store = new ModelServerStore(cipher(), memoryFile(), logger);
      await store.add(base, { type: 'none' });
      await expect(store.add({ ...base, name: 'GPU  Box' }, { type: 'none' })).rejects.toThrow(/already called/);
      await expect(store.add({ ...base, name: 'this computer' }, { type: 'none' })).rejects.toThrow(/already called/);
    });

    describe('when the write fails', () => {
      function failingOnce(file = memoryFile()) {
        const write = file.write.bind(file);
        const state = { fail: false };
        file.write = (next: string) => {
          if (!state.fail) return write(next);
          state.fail = false;
          return Promise.reject(new Error('disk full'));
        };
        return { file, state };
      }

      it('does not list a server it could not save', async () => {
        const { file, state } = failingOnce();
        const store = new ModelServerStore(cipher(), file, logger);
        state.fail = true;
        await expect(store.add(base, { type: 'bearer', token: TOKEN })).rejects.toThrow(/disk full/);
        expect(await store.list()).toEqual([]);
        await expect(store.add(base, { type: 'none' })).resolves.toMatchObject({ name: 'gpu box' });
      });

      it('keeps the old credential when saving a new one fails', async () => {
        const { file, state } = failingOnce();
        const store = new ModelServerStore(cipher(), file, logger);
        const record = await store.add(base, { type: 'bearer', token: TOKEN });
        state.fail = true;
        await expect(
          store.update(record.id, { credential: { type: 'header', name: 'X-Api-Key', value: HEADER_VALUE } })
        ).rejects.toThrow(/disk full/);
        const [saved] = await store.list();
        expect(saved.auth).toEqual({ type: 'bearer' });
        expect(store.headers(saved)).toEqual({ authorization: `Bearer ${TOKEN}` });
        expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
      });

      it('keeps a server and its credential when removing it fails', async () => {
        const { file, state } = failingOnce();
        const store = new ModelServerStore(cipher(false), file, logger);
        const record = await store.add(base, { type: 'bearer', token: TOKEN });
        state.fail = true;
        await expect(store.remove(record.id)).rejects.toThrow(/disk full/);
        expect(await store.list()).toHaveLength(1);
        expect(store.headers(record)).toEqual({ authorization: `Bearer ${TOKEN}` });
      });

      it('keeps the entered hardware when saving new figures fails', async () => {
        const { file, state } = failingOnce();
        const store = new ModelServerStore(cipher(), file, logger);
        const record = await store.add(base, { type: 'none' });
        const specs = { ramGiB: 64, gpuMemoryGiB: 24, bandwidthGBps: null, unified: false };
        await store.update(record.id, { specs });
        await store.setLocalSpecs(specs);
        state.fail = true;
        await expect(store.update(record.id, { specs: { ...specs, ramGiB: 128 } })).rejects.toThrow(/disk full/);
        state.fail = true;
        await expect(store.setLocalSpecs(null)).rejects.toThrow(/disk full/);
        expect((await store.get(record.id))?.specs).toEqual(specs);
        expect(await store.localSpecs()).toEqual(specs);
      });
    });

    it('keeps both servers when two are added at once', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      await Promise.all([store.add(base, { type: 'none' }), store.add({ ...base, name: 'second' }, { type: 'none' })]);
      expect((await store.list()).map(server => server.name).sort()).toEqual(['gpu box', 'second']);
      expect(JSON.parse(file.contents!).servers).toHaveLength(2);
    });

    it('saves, reads back and clears entered hardware for a server and for this computer', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'none' });
      expect(record.specs).toBeNull();
      const specs = { ramGiB: 128, gpuMemoryGiB: 96, bandwidthGBps: 256, unified: true };
      expect((await store.update(record.id, { specs })).specs).toEqual(specs);
      // This computer's probe decides unified memory, so the flag is not kept for it.
      expect(await store.setLocalSpecs({ ...specs, ramGiB: 64 })).toEqual({ ...specs, ramGiB: 64, unified: false });

      const reopened = new ModelServerStore(cipher(), file, logger);
      expect((await reopened.get(record.id))?.specs).toEqual(specs);
      expect(await reopened.localSpecs()).toEqual({ ...specs, ramGiB: 64, unified: false });

      await reopened.update(record.id, { specs: null });
      await reopened.setLocalSpecs({ ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false });
      expect(JSON.parse(file.contents!).servers[0].specs).toBeUndefined();
      expect(JSON.parse(file.contents!).localSpecs).toBeUndefined();
    });

    it('refuses specs Settings should not send, and ignores a stored shape it cannot use', async () => {
      const store = new ModelServerStore(cipher(), memoryFile(), logger);
      const record = await store.add(base, { type: 'none' });
      const blank = { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
      await expect(store.update(record.id, { specs: { ...blank, gpuMemoryGiB: 24 } })).rejects.toThrow('Enter the RAM');
      await expect(store.update(record.id, { specs: { ...blank, ramGiB: -1 } })).rejects.toThrow('RAM');
      await expect(store.setLocalSpecs({ ...blank, bandwidthGBps: Number.NaN })).rejects.toThrow('bandwidth');
      // GPU memory alone is fine for this computer, whose probe supplies the RAM.
      expect(await store.setLocalSpecs({ ...blank, gpuMemoryGiB: 24 })).toEqual({ ...blank, gpuMemoryGiB: 24 });

      const odd = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [{ ...base, id: 'abc', auth: { type: 'none' }, specs: { ramGiB: 'lots' } }],
          localSpecs: { ramGiB: 1e9 },
        })
      );
      const reopened = new ModelServerStore(cipher(), odd, logger);
      expect((await reopened.get('abc'))?.specs).toBeNull();
      expect(await reopened.localSpecs()).toBeNull();
    });

    it("keeps launch settings for this computer and each server across a restart, apart from the server's specs", async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'none' });
      expect(store.localLaunch()).toEqual({});
      expect(store.launchSettings(record.id)).toEqual({});
      expect(await store.setLocalLaunch({ kvCacheType: 'q8_0', flashAttention: 'on' })).toEqual({
        kvCacheType: 'q8_0',
        flashAttention: 'on',
      });
      const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
      await store.update(record.id, { specs, launch: { kvCacheType: 'q4_0' } });
      await store.update(record.id, { name: 'renamed' });

      const reopened = new ModelServerStore(cipher(), file, logger);
      expect((await reopened.get(record.id))?.specs).toEqual(specs);
      expect(reopened.localLaunch()).toEqual({ kvCacheType: 'q8_0', flashAttention: 'on' });
      expect(reopened.launchSettings(record.id)).toEqual({ kvCacheType: 'q4_0' });
      await reopened.setLocalLaunch({});
      await reopened.update(record.id, { launch: {} });
      const saved = JSON.parse(file.contents!);
      expect(saved.localLaunch).toBeUndefined();
      expect(saved.servers[0].launch).toBeUndefined();
    });

    it('drops launch settings when the server changes kind, since another program runs it', async () => {
      const store = new ModelServerStore(cipher(), memoryFile(), logger);
      const record = await store.add(base, { type: 'none' });
      await store.update(record.id, { launch: { kvCacheType: 'q8_0' } });
      await store.update(record.id, { kind: 'openai-compatible' });
      expect(store.launchSettings(record.id)).toEqual({});
      await store.update(record.id, { kind: 'ollama', launch: { flashAttention: 'off' } });
      expect(store.launchSettings(record.id)).toEqual({ flashAttention: 'off' });
    });

    describe('a KV cache type saved under Hardware', () => {
      const specs = { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
      const server = {
        id: 'a1',
        name: 'spare',
        kind: 'ollama',
        transport: { type: 'http', baseUrl: 'http://127.0.0.1:11500' },
        access: 'chat',
        auth: { type: 'none' },
      };

      it('stays in Hardware for a remote or SSH Ollama, which Desktop cannot start', async () => {
        const remote = { ...server, transport: { type: 'http', baseUrl: 'http://10.0.0.5:11434' } };
        const ssh = { ...server, id: 'b2', transport: { type: 'ssh', destination: 'me@gpu' } };
        const file = memoryFile(
          JSON.stringify({
            version: 1,
            servers: [
              { ...remote, specs: { ...specs, kvCacheType: 'q4_0' } },
              { ...ssh, specs: { ...specs, kvCacheType: 'q8_0' } },
            ],
          })
        );
        const store = new ModelServerStore(cipher(), file, logger);
        expect((await store.get('a1'))?.specs).toEqual({ ...specs, kvCacheType: 'q4_0' });
        expect((await store.get('b2'))?.specs).toEqual({ ...specs, kvCacheType: 'q8_0' });
        expect(store.launchSettings('a1')).toEqual({});
        expect(store.launchSettings('b2')).toEqual({});

        await store.update('a1', { specs: { ...specs, kvCacheType: 'q8_0' } });
        const saved = JSON.parse(file.contents!);
        expect(saved.servers[0].specs).toEqual({ ...specs, kvCacheType: 'q8_0' });
        expect(saved.servers[0].launch).toBeUndefined();
        expect((await store.update('a1', { kind: 'openai-compatible' })).specs).toEqual(specs);
      });

      it('is not kept in Hardware for a server Desktop can start', async () => {
        const file = memoryFile(JSON.stringify({ version: 1, servers: [{ ...server, specs }] }));
        const store = new ModelServerStore(cipher(), file, logger);
        expect((await store.update('a1', { specs: { ...specs, kvCacheType: 'q8_0' } })).specs).toEqual(specs);
      });

      it('becomes the launch cache type of this computer and of a server with none', async () => {
        const file = memoryFile(
          JSON.stringify({
            version: 1,
            servers: [{ ...server, specs: { ...specs, kvCacheType: 'q4_0' } }],
            localSpecs: { ...specs, kvCacheType: 'q8_0' },
            localLaunch: { flashAttention: 'on' },
          })
        );
        const store = new ModelServerStore(cipher(), file, logger);
        expect(await store.localSpecs()).toEqual(specs);
        expect(store.localLaunch()).toEqual({ kvCacheType: 'q8_0', flashAttention: 'on' });
        expect(store.launchSettings('a1')).toEqual({ kvCacheType: 'q4_0' });
        expect((await store.get('a1'))?.specs).toEqual(specs);

        await store.update('a1', { name: 'renamed' });
        const saved = JSON.parse(file.contents!);
        expect(saved.servers[0].specs).toEqual(specs);
        expect(saved.servers[0].launch).toEqual({ kvCacheType: 'q4_0' });
      });

      it('leaves a cache type or flash attention setting saved under Launch as it is', async () => {
        const file = memoryFile(
          JSON.stringify({
            version: 1,
            servers: [
              { ...server, specs: { ...specs, kvCacheType: 'q4_0' }, launch: { kvCacheType: 'q8_0' } },
              { ...server, id: 'b2', specs: { ...specs, kvCacheType: 'q4_0' }, launch: { flashAttention: 'off' } },
            ],
            localSpecs: { ...specs, kvCacheType: 'q4_0' },
            localLaunch: { kvCacheType: 'q8_0' },
          })
        );
        const store = new ModelServerStore(cipher(), file, logger);
        await store.localSpecs();
        expect(store.localLaunch()).toEqual({ kvCacheType: 'q8_0' });
        expect(store.launchSettings('a1')).toEqual({ kvCacheType: 'q8_0' });
        expect(store.launchSettings('b2')).toEqual({ flashAttention: 'off' });
      });

      it('is not carried to a server that is not Ollama', async () => {
        const file = memoryFile(
          JSON.stringify({
            version: 1,
            servers: [{ ...server, kind: 'openai-compatible', specs: { ...specs, kvCacheType: 'q8_0' } }],
          })
        );
        const store = new ModelServerStore(cipher(), file, logger);
        await store.list();
        expect(store.launchSettings('a1')).toEqual({});
      });
    });

    it('remembers the models a server found thinking across a restart, and forgets them with the server', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'none' });
      await store.addThinker(record.id, 'qwen3-8b');
      const written = file.contents;
      await store.addThinker(record.id, 'qwen3-8b');
      await store.addThinker('gone', 'qwen3-8b');
      expect(file.contents).toBe(written);

      const reopened = new ModelServerStore(cipher(), file, logger);
      expect(await reopened.thinkers(record.id)).toEqual([{ model: 'qwen3-8b' }]);
      await reopened.remove(record.id);
      expect(await reopened.thinkers(record.id)).toEqual([]);
      expect(JSON.parse(file.contents!)).not.toHaveProperty('thinkers');
    });

    it('keeps the identity a thinker was learned with, replaces it, and forgets the model', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add(base, { type: 'none' });
      await store.addThinker(record.id, 'qwen3-8b', 'a');
      await store.addThinker(record.id, 'phi-4');
      await store.addThinker(record.id, 'qwen3-8b', 'b');
      expect(await new ModelServerStore(cipher(), file, logger).thinkers(record.id)).toEqual([
        { model: 'phi-4' },
        { model: 'qwen3-8b', identity: 'b' },
      ]);
      await store.forgetThinker(record.id, 'qwen3-8b');
      await store.forgetThinker(record.id, 'phi-4');
      expect(JSON.parse(file.contents!)).not.toHaveProperty('thinkers');
    });

    it('forgets the thinkers of a server whose kind changes', async () => {
      const file = memoryFile();
      const store = new ModelServerStore(cipher(), file, logger);
      const record = await store.add({ ...base, kind: 'openai-compatible' }, { type: 'none' });
      await store.addThinker(record.id, 'qwen3-8b');
      await store.update(record.id, { kind: 'openai-compatible', name: 'renamed' });
      expect(await store.thinkers(record.id)).toEqual([{ model: 'qwen3-8b' }]);
      await store.update(record.id, { kind: 'ollama' });
      expect(await new ModelServerStore(cipher(), file, logger).thinkers(record.id)).toEqual([]);
    });

    it('keeps only the latest thinkers per server', async () => {
      const store = new ModelServerStore(cipher(), memoryFile(), logger);
      const record = await store.add(base, { type: 'none' });
      for (let index = 0; index <= 200; index++) await store.addThinker(record.id, `model-${index}`);
      const kept = await store.thinkers(record.id);
      expect(kept).toHaveLength(200);
      expect(kept[0]).toEqual({ model: 'model-1' });
      expect(kept.at(-1)).toEqual({ model: 'model-200' });
    });

    it('reads only well-formed thinkers from a stored map', async () => {
      const file = memoryFile(
        JSON.stringify({
          version: 1,
          servers: [],
          thinkers: { a: ['qwen3', 7, null, { model: 'phi-4', identity: 'x' }, { model: 3 }], b: 'x' },
        })
      );
      const store = new ModelServerStore(cipher(), file, logger);
      expect(await store.thinkers('a')).toEqual([{ model: 'qwen3' }, { model: 'phi-4', identity: 'x' }]);
      expect(await store.thinkers('b')).toEqual([]);
    });

    it(`stops at ${MAX_MODEL_SERVERS} servers`, async () => {
      const store = new ModelServerStore(cipher(), memoryFile(), logger);
      for (let index = 0; index < MAX_MODEL_SERVERS; index++) {
        await store.add({ ...base, name: `box ${index}` }, { type: 'none' });
      }
      await expect(store.add({ ...base, name: 'one more' }, { type: 'none' })).rejects.toThrow(/at most/);
    });
  });

  describe('credentialHeaders', () => {
    it('builds the header each credential type sends', () => {
      expect(credentialHeaders({ type: 'none' })).toBeNull();
      expect(credentialHeaders({ type: 'bearer', token: ` ${TOKEN} ` })).toEqual({ authorization: `Bearer ${TOKEN}` });
      expect(credentialHeaders({ type: 'header', name: 'X-Key', value: HEADER_VALUE })).toEqual({
        'x-key': HEADER_VALUE,
      });
    });

    it('refuses header names that would change the request itself', () => {
      for (const name of ['Host', 'Content-Length', 'Cookie', 'Transfer-Encoding']) {
        expect(() => credentialHeaders({ type: 'header', name, value: 'v' })).toThrow(/cannot carry/);
      }
      expect(() => credentialHeaders({ type: 'header', name: 'Bad Name', value: 'v' })).toThrow(/header name/);
    });

    it('refuses values that could split a header, without echoing them', () => {
      const value = `${HEADER_VALUE}\r\nX-Injected: 1`;
      let message = '';
      try {
        credentialHeaders({ type: 'header', name: 'X-Key', value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/not allow/);
      expect(message).not.toContain(HEADER_VALUE);
      expect(() => credentialHeaders({ type: 'bearer', token: 'two words' })).toThrow(/not allow/);
      for (const control of ['\x01', '\x1f', '\x7f']) {
        expect(() => credentialHeaders({ type: 'header', name: 'X-Key', value: `a${control}b` })).toThrow(
          /control character/
        );
        expect(() => credentialHeaders({ type: 'bearer', token: `a${control}b` })).toThrow(/control character/);
      }
      expect(credentialHeaders({ type: 'header', name: 'X-Key', value: 'a\tb' })).toEqual({ 'x-key': 'a\tb' });
      expect(() => credentialHeaders({ type: 'bearer', token: '   ' })).toThrow(/Enter the token/);
    });

    it('writes overlapping model-list updates one after another', async () => {
      let active = 0;
      let overlapped = false;
      const file: StoreFile = {
        read: () => Promise.resolve(null),
        write: async () => {
          overlapped ||= ++active > 1;
          await new Promise(resolve => setTimeout(resolve, 5));
          active--;
        },
      };
      const store = new ModelServerStore(cipher(), file, logger);
      const one = await store.add(base, { type: 'none' });
      const two = await store.add({ ...base, name: 'second' }, { type: 'none' });
      await Promise.all([store.setModels(one.id, ['a', 'b']), store.setModels(two.id, ['c'])]);
      expect(overlapped).toBe(false);
    });
  });

  describe('ModelServerStore.reencrypt', () => {
    async function legacyFile() {
      const file = memoryFile();
      const legacy = new ModelServerStore(versionedCipher('old'), file, logger);
      await legacy.add(base, { type: 'bearer', token: TOKEN });
      await legacy.add({ ...base, name: 'open box' }, { type: 'none' });
      return file;
    }
    const secrets = (file: { contents: string | null }) =>
      (JSON.parse(file.contents ?? '{}') as { servers: { name: string; secret?: string }[] }).servers.map(server => [
        server.name,
        server.secret && openedAs(server.secret),
      ]);

    it('re-seals a legacy credential once, and it still opens', async () => {
      const file = await legacyFile();
      const writes = vi.spyOn(file, 'write');
      const store = new ModelServerStore(versionedCipher('new'), file, logger);

      await store.reencrypt();
      await store.reencrypt();

      expect(secrets(file)).toEqual([
        ['gpu box', `new:${TOKEN}`],
        ['open box', undefined],
      ]);
      expect(writes).toHaveBeenCalledTimes(1);
      const reopened = new ModelServerStore(versionedCipher('new'), file, logger);
      const [saved] = await reopened.list();
      expect(reopened.headers(saved)).toEqual({ authorization: `Bearer ${TOKEN}` });
    });

    it('keeps a legacy credential it cannot open, so nothing is lost', async () => {
      const file = await legacyFile();
      const before = file.contents;
      const writes = vi.spyOn(file, 'write');

      await new ModelServerStore(versionedCipher('new', { opensOld: false }), file, logger).reencrypt();

      expect(writes).not.toHaveBeenCalled();
      expect(file.contents).toBe(before);
    });

    it('never rewrites a file from a newer version, or without a keychain', async () => {
      const newer = JSON.stringify({
        version: 2,
        servers: [{ ...base, id: 'aaaaaaaaaaaa', auth: { type: 'bearer' }, secret: sealedAs('old', TOKEN) }],
      });
      const newerFile = memoryFile(newer);
      await new ModelServerStore(versionedCipher('new'), newerFile, { debug: vi.fn(), warn: vi.fn() }).reencrypt();
      expect(newerFile.contents).toBe(newer);

      for (const current of [versionedCipher('new', { available: false }), cipher()]) {
        const file = await legacyFile();
        const writes = vi.spyOn(file, 'write');
        await new ModelServerStore(current, file, logger).reencrypt();
        expect(writes).not.toHaveBeenCalled();
      }
    });
  });
});

describe('ipc', () => {
  function register(probed?: Parameters<typeof registerModelServersIpc>[2]) {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
        handlers.set(channel, listener),
    } as unknown as Pick<IpcMain, 'handle'>;
    const registry = {
      views: vi.fn(async () => []),
      probe: vi.fn(),
      add: vi.fn(),
      update: vi.fn(async () => []),
      remove: vi.fn(),
      check: vi.fn(),
      startServer: vi.fn(async () => []),
      stopServer: vi.fn(async () => []),
      restartServer: vi.fn(async () => []),
    } as unknown as Parameters<typeof registerModelServersIpc>[1];
    registerModelServersIpc(ipc, registry, probed);
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
    return { registry, invoke };
  }

  describe('specsInput', () => {
    it('keeps numbers, blanks the rest, and reads anything but true as not unified', () => {
      expect(specsInput({ ramGiB: 64, gpuMemoryGiB: '24', bandwidthGBps: 900, unified: 'yes' })).toEqual({
        ramGiB: 64,
        gpuMemoryGiB: null,
        bandwidthGBps: 900,
        unified: false,
      });
      expect(specsInput(undefined)).toBeUndefined();
      expect(specsInput(null)).toBeNull();
      expect(specsInput('64')).toBeNull();
    });

    it('keeps a quantized KV cache type, which a remote Ollama keeps under Hardware, and drops any other', () => {
      const blank = { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
      expect(specsInput({ ...blank, kvCacheType: 'q4_0' })).toEqual({ ...blank, kvCacheType: 'q4_0' });
      expect(specsInput({ ...blank, kvCacheType: 'f16' })).toEqual(blank);
      expect(specsInput({ ...blank, kvCacheType: 'q8_0; rm' })).toEqual(blank);
    });
  });

  describe('registerModelServersIpc check', () => {
    it('marks a check the renderer asks for as a user check, so Desktop looks for Ollama again', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersCheck, 'local');
      await invoke(IPC_CHANNELS.modelServersCheck);
      expect(registry.check).toHaveBeenNthCalledWith(1, 'local', { lookAgain: true });
      expect(registry.check).toHaveBeenNthCalledWith(2, undefined, { lookAgain: true });
    });
  });

  describe('registerModelServersIpc launch', () => {
    it('passes launch settings through their shape and drops anything else', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersUpdate, 'local', {
        launch: { kvCacheType: 'q8_0', flashAttention: 'on', modelsDir: ' /m ', extra: 'x' },
      });
      await invoke(IPC_CHANNELS.modelServersUpdate, 'local', {
        launch: { kvCacheType: 'q8_0; rm', flashAttention: 1 },
      });
      expect(registry.update).toHaveBeenNthCalledWith(1, 'local', {
        launch: { kvCacheType: 'q8_0', flashAttention: 'on', modelsDir: '/m' },
      });
      expect(registry.update).toHaveBeenNthCalledWith(2, 'local', { launch: {} });
    });

    it('runs start, stop and restart, and refuses any other action', async () => {
      const { registry, invoke } = register();
      expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'start')).toEqual({ ok: true, servers: [] });
      await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'stop');
      await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'restart');
      expect(registry.startServer).toHaveBeenCalledWith('abc');
      expect(registry.stopServer).toHaveBeenCalledWith('abc');
      expect(registry.restartServer).toHaveBeenCalledWith('abc');
      expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'kill')).toEqual({
        ok: false,
        error: 'Unknown server action.',
      });
    });

    it('answers a failed start with its message', async () => {
      const { registry, invoke } = register();
      vi.mocked(registry.startServer).mockRejectedValueOnce(new Error('port 11500 is in use'));
      expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'start')).toEqual({
        ok: false,
        error: 'port 11500 is in use',
      });
    });

    it('passes a launch add through only when asked', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersAdd, { address: 'http://127.0.0.1:8090', name: 'r', launch: true });
      await invoke(IPC_CHANNELS.modelServersAdd, { address: 'http://127.0.0.1:8090', name: 'r', launch: 'yes' });
      expect(registry.add).toHaveBeenNthCalledWith(1, expect.objectContaining({ launch: true }));
      expect(registry.add).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ launch: expect.anything() }));
    });
  });

  describe('registerModelServersIpc transport', () => {
    it('passes an SSH destination through as ssh and anything else as http', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh' });
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'gpu:11434', transport: 'telnet' });
      await invoke(IPC_CHANNELS.modelServersAdd, { address: 'me@gpu', transport: 'ssh', name: 'gpu' });
      expect(registry.probe).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ address: 'me@gpu', transport: 'ssh' })
      );
      expect(registry.probe).toHaveBeenNthCalledWith(2, expect.objectContaining({ transport: 'http' }));
      expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({ address: 'me@gpu', transport: 'ssh' }));
    });

    it('passes a port through as typed for the registry to check, and one of any other type as invalid', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh', port: 8080 });
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh', port: '8080;id' });
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh', port: { toString: 'x' } });
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh', port: null });
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh' });
      await invoke(IPC_CHANNELS.modelServersAdd, { address: 'me@gpu', transport: 'ssh', port: '1234', name: 'gpu' });
      expect(registry.probe).toHaveBeenNthCalledWith(1, expect.objectContaining({ port: 8080 }));
      expect(registry.probe).toHaveBeenNthCalledWith(2, expect.objectContaining({ port: '8080;id' }));
      expect(registry.probe).toHaveBeenNthCalledWith(3, expect.objectContaining({ port: 'invalid' }));
      expect(registry.probe).toHaveBeenNthCalledWith(4, expect.objectContaining({ port: 'invalid' }));
      expect(registry.probe).toHaveBeenNthCalledWith(5, expect.not.objectContaining({ port: expect.anything() }));
      expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({ port: '1234' }));
    });

    it('passes text too long to be a port as invalid, not cut down to the port it starts with', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh', port: '8080            x' });
      expect(registry.probe).toHaveBeenCalledWith(expect.objectContaining({ port: 'invalid' }));
    });
  });

  describe('registerModelServersIpc hardware', () => {
    it('passes entered specs to the registry and leaves them out when not sent', async () => {
      const { registry, invoke } = register();
      await invoke(IPC_CHANNELS.modelServersUpdate, 'gpu', {
        specs: { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: true },
      });
      await invoke(IPC_CHANNELS.modelServersUpdate, 'gpu', { name: 'gpu box' });
      expect(registry.update).toHaveBeenNthCalledWith(1, 'gpu', {
        specs: { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: true },
      });
      expect(registry.update).toHaveBeenNthCalledWith(2, 'gpu', { name: 'gpu box' });
    });

    it("answers this computer's probed hardware, and null when the probe fails", async () => {
      const machine = machineView({
        platform: 'linux',
        arch: 'x64',
        memoryKind: 'cpu',
        totalMemoryBytes: 1,
        gpuMemoryBytes: null,
        gpuName: null,
        gpuCount: 0,
        chip: null,
        diskFreeBytes: null,
        confidence: 'high',
      });
      expect(await register(async () => machine).invoke(IPC_CHANNELS.modelServersProbedHardware)).toEqual(machine);
      expect(
        await register(() => Promise.reject(new Error('no probe'))).invoke(IPC_CHANNELS.modelServersProbedHardware)
      ).toBeNull();
    });
  });
});

describe('shared copies', () => {
  // @bike4mind/local-models/servers copies these from shared/chat.ts and shared/modelServers.ts, which the
  // renderer imports and so cannot come from a Node package. The CLI reads Desktop's file through that copy,
  // so a drift here would make its model ids and server rules disagree with Desktop's.
  describe('the local-models copies of the shared server helpers', () => {
    it('build and parse the same model ids', () => {
      for (const [runtime, model] of [
        ['ollama', 'qwen3:8b'],
        [serverRuntimeId('a1b2'), 'org/model:q4'],
        ['with:colon', 'm'],
      ]) {
        expect(serverRuntimeId(runtime)).toBe(shared.serverRuntimeId(runtime));
        const id = localModelId(runtime, model);
        expect(id).toBe(chat.localModelId(runtime, model));
        expect(parseLocalModelId(id)).toEqual(chat.parseLocalModelId(id));
      }
      for (const id of ['local:%E0%A4%A:x', 'local:x', 'hosted-model']) {
        expect(parseLocalModelId(id)).toEqual(chat.parseLocalModelId(id));
      }
    });

    it('allow the same management on every kind of server', () => {
      for (const local of [true, false]) {
        for (const kind of ['ollama', 'openai-compatible'] as const) {
          for (const access of ['chat', 'manage'] as const) {
            expect(serverManagement({ local, kind, access })).toBe(shared.serverManagement({ local, kind, access }));
          }
        }
      }
    });

    it('accept the same saved specs', () => {
      // Desktop's own readSpecs before the move: range-checked, and RAM not required.
      const desktopSpecs = (value: unknown) => {
        const specs = shared.readSpecsShape(value);
        if (!specs || shared.specsBlank(specs)) return null;
        return shared.specsProblem(specs, true) ? null : specs;
      };
      const base = { ramGiB: 32, gpuMemoryGiB: null, bandwidthGBps: null, unified: true };
      for (const specs of [
        base,
        { ...base, ramGiB: shared.MAX_SPEC_MEMORY_GIB },
        { ...base, ramGiB: shared.MAX_SPEC_MEMORY_GIB + 1 },
        { ...base, gpuMemoryGiB: shared.MAX_SPEC_MEMORY_GIB + 1 },
        { ...base, bandwidthGBps: shared.MAX_SPEC_BANDWIDTH_GBPS },
        { ...base, bandwidthGBps: shared.MAX_SPEC_BANDWIDTH_GBPS + 1 },
        { ...base, ramGiB: 0 },
        { ...base, ramGiB: Number.NaN },
        { ...base, ramGiB: '32' },
        { ramGiB: null, gpuMemoryGiB: 24, bandwidthGBps: null },
        { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null },
        { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, kvCacheType: 'q8_0' },
        { ...base, kvCacheType: 'q4_0' },
        { ...base, kvCacheType: 'f16' },
        { ...base, kvCacheType: 'q5_1' },
        null,
        'specs',
      ]) {
        expect(readSpecs(specs)).toEqual(desktopSpecs(specs));
      }
    });

    it('take the same KV cache types', () => {
      expect(QUANTIZED_KV_CACHE_TYPES).toEqual(shared.QUANTIZED_KV_CACHE_TYPES);
    });

    it('name the same OpenAI-compatible products', () => {
      // Fails the typecheck, not the run, when one side gains a product the other lacks.
      type Same = [OpenAICompatibleProduct] extends [shared.ModelServerProduct]
        ? [shared.ModelServerProduct] extends [OpenAICompatibleProduct]
          ? true
          : false
        : false;
      const same: Same = true;
      expect(same).toBe(true);
    });
  });
});

describe('localNetworkHint', () => {
  describe('localNetworkHint', () => {
    it('applies to an unreachable private address on macOS', () => {
      expect(localNetworkHint('EHOSTUNREACH', 'private', 'darwin')).toBe(LOCAL_NETWORK_HINT);
      expect(localNetworkHint('ENETUNREACH', 'private', 'darwin')).toBe(LOCAL_NETWORK_HINT);
    });

    it('does not apply on other platforms, to other scopes or to other failures', () => {
      expect(localNetworkHint('EHOSTUNREACH', 'private', 'linux')).toBeNull();
      expect(localNetworkHint('EHOSTUNREACH', 'private', 'win32')).toBeNull();
      expect(localNetworkHint('EHOSTUNREACH', 'public', 'darwin')).toBeNull();
      expect(localNetworkHint('EHOSTUNREACH', 'loopback', 'darwin')).toBeNull();
      expect(localNetworkHint('EHOSTUNREACH', null, 'darwin')).toBeNull();
      expect(localNetworkHint('ECONNREFUSED', 'private', 'darwin')).toBeNull();
      expect(localNetworkHint(null, 'private', 'darwin')).toBeNull();
    });

    it('appends the hint to a message only when it applies', () => {
      expect(withLocalNetworkHint('Could not reach gpu box.', 'EHOSTUNREACH', 'private', 'darwin')).toBe(
        `Could not reach gpu box. ${LOCAL_NETWORK_HINT}`
      );
      expect(
        withLocalNetworkHint('Could not reach gpu box: no route to the host', 'EHOSTUNREACH', 'private', 'darwin')
      ).toBe(`Could not reach gpu box: no route to the host. ${LOCAL_NETWORK_HINT}`);
      expect(withLocalNetworkHint('Could not reach gpu box.', 'EHOSTUNREACH', 'private', 'linux')).toBe(
        'Could not reach gpu box.'
      );
    });
  });
});

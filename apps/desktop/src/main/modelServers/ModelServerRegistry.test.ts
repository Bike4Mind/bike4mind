import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@bike4mind/local-models';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { ServerCredentialsError, ServerUnreachableError } from './errors';
import type { ChatModelOption } from '@shared/chat';
import type { ModelServerProbeInput, ModelServerProbeResult, ModelServerUpdateInput } from '@shared/modelServers';
import {
  foundServers,
  LISTED_FRESH_MS,
  ModelServerRegistry,
  PICKER_CHECK_WAIT_MS,
  PICKER_LIST_WAIT_MS,
} from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';
import { inertLaunchers } from './testLaunchers';
import {
  describeSshFailure,
  SshConnectionError,
  type ServerEndpoint,
  type SshEndpoint,
} from '@bike4mind/local-models/servers';
import { ModelCatalog } from '../chat/ModelCatalog';
import type { OllamaLocal } from '../chat/OllamaLocal';
import { LocalModels } from './LocalModels';

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
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5_000 });
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
    await vi.waitFor(async () => expect((await view()).toolsHint).toMatch(/without tool calling/), { timeout: 5_000 });
    const serverRows = vi.spyOn(servers, 'models');

    let release = () => {};
    computerGate = new Promise(resolve => (release = resolve));
    const read = catalog.listLocal(true);
    await vi.waitFor(() => expect(serverRows).toHaveBeenCalled(), { timeout: 5_000 });
    expect((await serverRows.mock.results[0].value)[0].supportsTools).toBe(false);
    refuseTools = false;
    await servers.check((await view()).id);
    await vi.waitFor(async () => expect((await view()).toolsHint).toBeUndefined(), { timeout: 5_000 });
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
        await vi.waitFor(() => expect(read.rows).toBeDefined(), { timeout: 5_000 });
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
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
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
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
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
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers
        .hubServer(slowId)
        ?.runtime.remove('qwen2.5:0.5b')
        .catch(() => undefined);
      let releaseSecond: () => void = () => {};
      fake.state.tagsGates.set(SLOW, new Promise<void>(resolve => (releaseSecond = resolve)));
      const second = servers.models();
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 2), { timeout: 5_000 });
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
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
      await servers.remove(slowId);
      release();
      const listed = await listing;
      expect(listed.filter(model => model.server?.id === slowId)).toEqual([]);
    });

    it('lists a server renamed while a picker waits on its listing as saved', async () => {
      const { fake, servers, slowId, listedBefore, release } = await slowAndFast();
      const listing = servers.models();
      await vi.waitFor(() => expect(tagCalls(fake, SLOW)).toBe(listedBefore + 1), { timeout: 5_000 });
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
        await vi.waitFor(() => expect(listed).not.toBeNull());
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
    await vi.waitFor(() => expect(asked).toBe(1));
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
    const done = { choices: [{ delta: {}, finish_reason: 'stop' }] };
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

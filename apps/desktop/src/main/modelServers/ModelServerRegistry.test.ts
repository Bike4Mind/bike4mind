import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@bike4mind/local-models';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { ServerCredentialsError, ServerUnreachableError } from './errors';
import type { ChatModelOption } from '@shared/chat';
import type { ModelServerProbeResult } from '@shared/modelServers';
import { ModelServerRegistry, PICKER_CHECK_WAIT_MS, PICKER_LIST_WAIT_MS } from './ModelServerRegistry';
import { ModelServerStore } from './ModelServerStore';
import {
  describeSshFailure,
  SshConnectionError,
  type ServerEndpoint,
  type SshEndpoint,
} from '@bike4mind/local-models/servers';
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
      if (url.pathname === '/api/tags') await state.tagsGates.get(url.origin);
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
  const instance = new ModelServerRegistry({
    store,
    logger: options.logger ?? { debug: () => undefined, warn: () => undefined },
    platform: options.platform,
    changed,
    listedLate,
    fetchFor: fake.fetchFor,
    localFetch: async () => json({ version: '0.12.0' }),
    resolve: typeof resolve === 'function' ? resolve : async host => resolve[host] ?? [],
  });
  return { registry: instance, store, changed, listedLate };
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
      const { registry: servers, listedLate } = registry(fake);
      await servers.add({ address: SLOW, credential: none, name: 'slow', kind: 'ollama', access: 'chat' });
      await servers.add({ address: FAST, credential: none, name: 'fast', kind: 'ollama', access: 'chat' });
      await servers.models();
      const slowId = (await servers.views())[1].id;
      names.push('llama3.2:3b');
      let release: () => void = () => {};
      fake.state.tagsGates.set(SLOW, new Promise<void>(resolve => (release = resolve)));
      const listedBefore = tagCalls(fake, SLOW);
      return { fake, servers, listedLate, slowId, listedBefore, release: () => release() };
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
        expect.objectContaining({ name: 'qwen2.5:0.5b', unavailable: 'slow is still listing its models' }),
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
      release();
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
    const listed = await Promise.race([
      servers.models(),
      new Promise(resolve => setTimeout(() => resolve('waited for the check'), 200)),
    ]);
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
    const listed = await Promise.race([
      servers.models(),
      new Promise(resolve => setTimeout(() => resolve('waited for the check'), 200)),
    ]);
    servers.stop();
    expect(listed).toEqual([expect.objectContaining({ name: 'qwen2.5:0.5b', server: expect.anything() })]);
    expect((listed as ChatModelOption[])[0].unavailable).toBeUndefined();
  });

  describe('a server shown as down with a check running', () => {
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
      return { servers, release, checking };
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
});

describe('ModelServerRegistry SSH servers', () => {
  type Mode = 'up' | 'down' | 'unknown-host-key';

  /** Each destination answers as the fake Ollama over SSH, or fails the way ssh does in `modes`. */
  function sshSetup(file: StoreFile = memoryFile()) {
    const fake = fakeOllama();
    const modes: Record<string, Mode> = {};
    const sshCalls: string[] = [];
    const sshFetchFor =
      (endpoint: SshEndpoint): FetchLike =>
      async (input, init) => {
        sshCalls.push(`${endpoint.destination} ${new URL(String(input)).pathname}`);
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
        return fake.fetchFor({
          origin: 'http://127.0.0.1:11434',
          label: endpoint.label,
          credentialHeaders: () => null,
        })(input, init);
      };
    const store = new ModelServerStore(cipher, file, { debug: () => undefined, warn: () => undefined });
    const instance = new ModelServerRegistry({
      store,
      logger: { debug: () => undefined, warn: () => undefined },
      fetchFor: fake.fetchFor,
      sshFetchFor,
      localFetch: async () => json({ version: '0.12.0' }),
      resolve: async () => [],
    });
    return { registry: instance, store, fake, modes, sshCalls };
  }

  const addSsh = (servers: ModelServerRegistry, destination = 'me@gpu', name = 'lab') =>
    servers.add({ address: destination, transport: 'ssh', credential: none, name, kind: 'ollama', access: 'chat' });

  it('adds a server by SSH destination under its own id, as Ollama with no credential', async () => {
    const { registry: servers, store } = sshSetup();
    await servers.add({
      address: ' me@gpu ',
      transport: 'ssh',
      credential: { type: 'bearer', token: TOKEN },
      name: 'lab',
      kind: 'openai-compatible',
      access: 'chat',
    });
    const [, lab] = await servers.views();
    expect(lab).toMatchObject({
      transport: 'ssh',
      address: 'me@gpu',
      kind: 'ollama',
      auth: { type: 'none' },
      unencrypted: false,
      health: { state: 'online', version: '0.12.0' },
      models: ['qwen2.5:0.5b'],
    });
    expect(lab.id).toMatch(/^[0-9a-f]{12}$/);
    const [record] = await store.list();
    expect(record.transport).toEqual({ type: 'ssh', destination: 'me@gpu' });
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

  it('keeps an SSH server on Ollama with no credential', async () => {
    const { registry: servers } = sshSetup();
    await addSsh(servers);
    const [, lab] = await servers.views();
    await expect(servers.update(lab.id, { kind: 'openai-compatible' })).rejects.toThrow(/kind stays Ollama/);
    await expect(servers.update(lab.id, { credential: { type: 'bearer', token: TOKEN } })).rejects.toThrow(/SSH keys/);
    const views = await servers.update(lab.id, { access: 'manage' });
    expect(views[1]).toMatchObject({ access: 'manage', transport: 'ssh' });
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

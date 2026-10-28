import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HubGgufBuild, HubModelDetail, PullProgress } from '@bike4mind/local-models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecretCipher, StoreFile } from '../chat/mcp/McpServerStore';
import { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { ModelServerStore } from '../modelServers/ModelServerStore';
import { ModelHubService, type ModelHubPort, type ModelRuntimePort } from './ModelHubService';

const TOKEN = 'tok-secret-zz';
const REPO = 'Qwen/Qwen2.5-0.5B-Instruct-GGUF';
const REF = `hf.co/${REPO}:Q4_K_M`;
const TOTAL = 1_000;

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

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise(resolve => {
          server.closeAllConnections();
          server.close(resolve);
        })
    )
  );
});

/**
 * How the first pull ends: `drop` closes the connection, `quiet` stops writing and leaves it open (a network
 * drop no packet reports), `stall` stays open and is never resumed, `error` sends Ollama's error frame.
 */
type FirstPull = 'drop' | 'quiet' | 'stall' | 'error';

/**
 * An Ollama behind a bearer token. Its first pull streams part of the blob and then ends as `first` says;
 * the next pull of the same name starts from the partial file, as Ollama's does.
 */
async function fakeOllama(first: FirstPull = 'drop') {
  const state = { stored: 0, installed: [] as string[], pulls: [] as string[], authorized: [] as boolean[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
      state.authorized.push(authorized);
      if (!authorized) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"unauthorized"}');
      }
      const json = (value: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/version') return json({ version: '0.12.0' });
      if (req.url === '/api/tags') return json({ models: state.installed.map(name => ({ name, size: TOTAL })) });
      if (req.url === '/api/ps') return json({ models: [] });
      if (req.url === '/api/show') return json({ capabilities: ['completion'], model_info: {} });
      if (req.url !== '/api/pull') return json({});
      const { model } = JSON.parse(body) as { model: string };
      state.pulls.push(model);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const frame = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
      frame({ status: 'pulling manifest' });
      frame({ status: 'pulling sha256:aa', digest: 'sha256:aa', total: TOTAL, completed: state.stored });
      if (state.pulls.length === 1 || first === 'stall') {
        state.stored = 400;
        frame({ status: 'pulling sha256:aa', digest: 'sha256:aa', total: TOTAL, completed: state.stored });
        if (first === 'drop') setTimeout(() => res.socket?.destroy(), 20);
        if (first === 'error') {
          frame({ error: 'max retries exceeded: unexpected EOF' });
          res.end();
        }
        return;
      }
      state.stored = TOTAL;
      frame({ status: 'pulling sha256:aa', digest: 'sha256:aa', total: TOTAL, completed: TOTAL });
      frame({ status: 'verifying sha256 digest' });
      frame({ status: 'writing manifest' });
      state.installed.push(model);
      frame({ status: 'success' });
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state };
}

function detail(): HubModelDetail {
  const build: HubGgufBuild = {
    id: 'q4',
    quant: 'Q4_K_M',
    files: [{ path: 'q4_k_m.gguf', sizeBytes: TOTAL, sha256: 'a'.repeat(64), url: 'https://x' }],
    sizeBytes: TOTAL,
    split: false,
    complete: true,
    ollamaRef: REF,
    ollamaRefIssue: null,
  };
  return {
    id: REPO,
    author: 'Qwen',
    downloads: 1,
    likes: 1,
    updatedAt: null,
    pipelineTag: 'text-generation',
    gated: false,
    private: false,
    licenses: ['apache-2.0'],
    baseModels: [],
    tags: ['gguf'],
    revision: 'b'.repeat(40),
    licenseName: null,
    licenseLink: null,
    gguf: null,
    builds: [build],
    projectors: [],
    canDownload: true,
    ollamaNeedsSshKey: false,
  };
}

const hub = {
  endpoint: 'https://huggingface.co',
  search: async () => ({ models: [], nextCursor: null }),
  getModel: async () => detail(),
  verifyOllamaRef: async () => REF,
} satisfies ModelHubPort;

const unusedLocal: ModelRuntimePort = {
  baseUrl: 'http://127.0.0.1:11434',
  health: async () => ({ ok: true, version: '0.12.0', error: null }),
  list: async () => [],
  loaded: async () => [],
  pull: () => Promise.reject(new Error('this computer must not be asked')),
  remove: () => Promise.reject(new Error('this computer must not be asked')),
};

async function setup(
  access: 'chat' | 'manage',
  options: { first?: FirstPull; idleTimeoutMs?: number; followSettings?: boolean } = {}
) {
  const fake = await fakeOllama(options.first);
  const registry = new ModelServerRegistry({
    store: new ModelServerStore(cipher, memoryFile(), { debug: () => undefined, warn: () => undefined }),
    logger: { debug: () => undefined, warn: () => undefined },
  });
  const [, saved] = await registry.add({
    address: fake.origin,
    credential: { type: 'bearer', token: TOKEN },
    name: 'gpu box',
    kind: 'ollama',
    access,
  });
  // Every frame Ollama sent, as OllamaRuntime folded it, per pull request.
  const frames: PullProgress[][] = [];
  const keepAwake = vi.fn();
  const installedChanged = vi.fn();
  const service = new ModelHubService({
    runtime: unusedLocal,
    server: id => {
      const server = registry.hubServer(id);
      if (!server) return null;
      return {
        ...server,
        runtime: {
          ...server.runtime,
          pull: (ref, pullOptions) => {
            const mine: PullProgress[] = [];
            frames.push(mine);
            return server.runtime.pull(ref, {
              ...pullOptions,
              ...(options.idleTimeoutMs ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
              onProgress: progress => {
                mine.push(progress);
                pullOptions?.onProgress?.(progress);
              },
            });
          },
        },
      };
    },
    hub,
    onPullsChanged: () => undefined,
    onInstalledChanged: installedChanged,
    keepAwake,
    progressIntervalMs: 0,
  });
  if (options.followSettings) registry.onServerSaved(id => service.serverChanged(id));
  return { fake, registry, service, serverId: saved.id, frames, keepAwake, installedChanged };
}

const request = (serverId: string) => ({
  repo: REPO,
  buildId: 'q4',
  revision: 'b'.repeat(40),
  sizeBytes: TOTAL,
  acceptLicense: false,
  confirmAccess: false,
  serverId,
});

describe('ModelHubService on a saved model server', () => {
  it('pauses a pull when the connection drops, and resume continues from the partial file', async () => {
    const { fake, registry, service, serverId, frames, keepAwake, installedChanged } = await setup('manage');

    const first = await service.pull(request(serverId));
    expect(first).toMatchObject({ ok: false, error: { kind: 'connection-lost' }, listed: true });
    const [paused] = service.pulls();
    expect(paused).toMatchObject({ serverId, serverName: 'gpu box', phase: 'paused', completedBytes: 400 });
    expect(paused.error?.message).toContain('lost the connection to gpu box');
    expect(keepAwake.mock.calls).toEqual([[true], [false]]);
    expect((await registry.views()).find(view => view.id === serverId)?.health.state).toBe('unreachable');

    const resumed = await service.resume(paused.key);

    expect(resumed).toEqual({ ok: true, ref: REF });
    expect(fake.state.pulls).toEqual([REF, REF]);
    const firstAfterResume = frames[1].find(frame => frame.totalBytes !== null);
    expect(firstAfterResume?.completedBytes).toBeGreaterThan(0);
    expect(service.pulls()).toEqual([]);
    expect(keepAwake.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(installedChanged).toHaveBeenCalledWith(serverId);
    expect(fake.state.authorized.every(Boolean)).toBe(true);

    await registry.check(serverId);
    const picker = await registry.models();
    expect(picker).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: REF, server: { id: serverId, name: 'gpu box' } })])
    );
    expect(picker.find(model => model.name === REF)?.unavailable).toBeUndefined();
  });

  it('lists the resumed model for chat right away, once the recheck the pull started settles', async () => {
    const { registry, service, serverId, installedChanged } = await setup('manage');
    await service.pull(request(serverId));
    expect((await registry.views()).find(view => view.id === serverId)?.health.state).toBe('unreachable');

    expect(await service.resume(service.pulls()[0].key)).toEqual({ ok: true, ref: REF });
    expect(installedChanged).toHaveBeenCalledTimes(1);
    const picker = await registry.models();

    expect(picker.find(model => model.name === REF)).toMatchObject({ server: { id: serverId } });
    expect(picker.find(model => model.name === REF)?.unavailable).toBeUndefined();
  });

  it('pauses a pull when the server goes quiet without closing, keeps it Online for chat, and resumes', async () => {
    const { fake, registry, service, serverId, keepAwake } = await setup('manage', {
      first: 'quiet',
      idleTimeoutMs: 50,
    });

    const first = await service.pull(request(serverId));
    expect(first).toMatchObject({ ok: false, error: { kind: 'connection-lost' }, listed: true });
    const [paused] = service.pulls();
    expect(paused).toMatchObject({ phase: 'paused', completedBytes: 400 });
    expect(paused.error?.message).toContain('lost the connection to gpu box');
    expect(paused.error?.message).not.toContain('srv-');
    const health = (await registry.views()).find(view => view.id === serverId)?.health;
    expect(health).toMatchObject({ state: 'online', error: null });
    expect(keepAwake.mock.calls).toEqual([[true], [false]]);

    expect(await service.resume(paused.key)).toEqual({ ok: true, ref: REF });
    expect(fake.state.pulls).toEqual([REF, REF]);
    expect(service.pulls()).toEqual([]);
  });

  it.each([
    [
      'set to Chat only',
      'not-allowed',
      (registry: ModelServerRegistry, id: string) => registry.update(id, { access: 'chat' }),
    ],
    ['removed', 'not-found', (registry: ModelServerRegistry, id: string) => registry.remove(id)],
  ] as const)('resume refuses a server %s while paused, and sends it nothing', async (_label, kind, change) => {
    const { fake, registry, service, serverId, keepAwake } = await setup('manage');
    await service.pull(request(serverId));
    const [paused] = service.pulls();
    await change(registry, serverId);

    expect(await service.resume(paused.key)).toMatchObject({ ok: false, error: { kind }, listed: true });
    expect(service.pulls()).toMatchObject([{ key: paused.key, phase: 'failed' }]);
    expect(fake.state.pulls).toEqual([REF]);
    expect(keepAwake.mock.calls).toEqual([[true], [false]]);
  });

  it.each([
    [
      'set to Chat only',
      'not-allowed',
      (registry: ModelServerRegistry, id: string) => registry.update(id, { access: 'chat' }),
    ],
    ['removed', 'not-found', (registry: ModelServerRegistry, id: string) => registry.remove(id)],
  ] as const)('stops a running pull and its wake lock once its server is %s', async (_label, kind, change) => {
    const { service, registry, serverId, keepAwake } = await setup('manage', { first: 'stall', followSettings: true });
    const running = service.pull(request(serverId));
    await vi.waitFor(() => expect(service.pulls()).toMatchObject([{ phase: 'downloading', completedBytes: 400 }]));

    await change(registry, serverId);

    await expect(running).resolves.toMatchObject({ ok: false, error: { kind }, listed: false });
    expect(service.pulls()).toEqual([]);
    expect(keepAwake.mock.calls).toEqual([[true], [false]]);
  });

  it('clears a paused pull once its server is set to Chat only, and keeps pulls to other changes', async () => {
    const { service, registry, serverId } = await setup('manage', { followSettings: true });
    await service.pull(request(serverId));
    await registry.update(serverId, { name: 'big gpu box' });
    expect(service.pulls()).toMatchObject([{ phase: 'paused' }]);

    await registry.update(serverId, { access: 'chat' });
    expect(service.pulls()).toEqual([]);
  });

  it('refuses a local pull whose repo spells out a server pull key, leaving that pull running', async () => {
    const { service, serverId } = await setup('manage', { first: 'stall' });
    void service.pull(request(serverId));
    await vi.waitFor(() => expect(service.pulls()).toMatchObject([{ phase: 'downloading' }]));
    const [running] = service.pulls();

    expect(
      await service.pull({ ...request(serverId), repo: `${serverId}/${REPO}`, serverId: undefined })
    ).toMatchObject({ ok: false, error: { kind: 'invalid' }, listed: false });
    expect(service.pulls()).toEqual([running]);
    service.dispose();
  });

  it('lets the computer sleep again after a cancel, a failure and a dispose', async () => {
    const stalled = await setup('manage', { first: 'stall' });
    const cancelled = stalled.service.pull(request(stalled.serverId));
    await vi.waitFor(() => expect(stalled.service.pulls()).toMatchObject([{ phase: 'downloading' }]));
    stalled.service.cancel(stalled.service.pulls()[0].key);
    await expect(cancelled).resolves.toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(stalled.keepAwake.mock.calls).toEqual([[true], [false]]);

    const disposed = stalled.service.pull(request(stalled.serverId));
    await vi.waitFor(() => expect(stalled.service.pulls()).toMatchObject([{ phase: 'downloading' }]));
    stalled.service.dispose();
    await expect(disposed).resolves.toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(stalled.keepAwake.mock.calls).toEqual([[true], [false], [true], [false]]);

    const failing = await setup('manage', { first: 'error' });
    expect(await failing.service.pull(request(failing.serverId))).toMatchObject({
      ok: false,
      error: { kind: 'failed' },
      listed: true,
    });
    expect(failing.keepAwake.mock.calls).toEqual([[true], [false]]);
  });

  it('refuses to pull to or remove from a Chat only server, and sends it nothing', async () => {
    const { fake, service, serverId } = await setup('chat');
    const before = fake.state.authorized.length;

    expect(await service.pull(request(serverId))).toMatchObject({
      ok: false,
      error: { kind: 'not-allowed', message: expect.stringContaining('gpu box is set to Chat only') },
      listed: false,
    });
    expect(await service.remove(REF, serverId)).toMatchObject({ ok: false, error: { kind: 'not-allowed' } });
    expect(fake.state.pulls).toEqual([]);
    expect(fake.state.authorized.length).toBe(before);
    expect(service.pulls()).toEqual([]);
    expect(await service.status(serverId)).toMatchObject({ reachable: true, management: 'chat-only' });
  });

  it('lists and removes through the same credentialed fetch as chat', async () => {
    const { fake, service, serverId, installedChanged } = await setup('manage');
    fake.state.installed.push('qwen2.5:0.5b');

    expect(await service.installed(serverId)).toMatchObject({ ok: true, models: [{ name: 'qwen2.5:0.5b' }] });
    expect(await service.status(serverId)).toMatchObject({
      reachable: true,
      version: '0.12.0',
      serverName: 'gpu box',
      management: 'allowed',
    });
    expect(await service.remove('qwen2.5:0.5b', serverId)).toEqual({ ok: true });
    expect(installedChanged).toHaveBeenCalledWith(serverId);
    expect(fake.state.authorized.every(Boolean)).toBe(true);
  });
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '@bike4mind/local-models';
import { THINKING_OFF_SETTING, type ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModels } from '../modelServers/LocalModels';
import { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { ModelServerStore } from '../modelServers/ModelServerStore';
import { ChatService } from './ChatService';
import type { SecretCipher, StoreFile } from './mcp/McpServerStore';
import { MessageQueue } from './MessageQueue';
import { ModelCatalog } from './ModelCatalog';
import type { OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const ADDRESS = 'http://192.168.1.20:11434';
const logger = { debug: () => undefined, warn: () => undefined };
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: plain => Buffer.from(plain, 'utf8'),
  decryptString: encrypted => encrypted.toString('utf8'),
};
const services: ChatService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

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

/** One saved Ollama server behind the registry and catalog, wired as registerChat wires them, and a conversation on it. */
async function fixture() {
  const down = new Set<string>();
  let computerGate: Promise<void> = Promise.resolve();
  const fetchFor = (): FetchLike => async input => {
    const url = new URL(String(input));
    if (down.has(url.origin)) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (url.pathname === '/api/version') return Response.json({ version: '0.12.0' });
    if (url.pathname === '/api/tags') return Response.json({ models: [{ name: 'qwen3:8b' }] });
    if (url.pathname === '/api/show')
      return Response.json({
        capabilities: ['completion', 'tools', 'thinking'],
        model_info: { 'qwen3.context_length': 32768 },
      });
    return new Response('', { status: 404 });
  };
  const holder: { catalog?: ModelCatalog } = {};
  const changed = vi.fn(() => holder.catalog?.expireLocal());
  const servers = new ModelServerRegistry({
    store: new ModelServerStore(cipher, memoryFile(), logger),
    logger,
    changed,
    edited: () => holder.catalog?.forgetLocal(),
    fetchFor,
    localFetch: async () => Response.json({ version: '0.12.0' }),
    resolve: async () => [],
  });
  const computer = {
    models: async () => {
      await computerGate;
      return [];
    },
  };
  const catalog = new ModelCatalog(
    { logger, getApiClient: () => null, getEnvironmentUrl: () => 'https://hosted.example.com' },
    new LocalModels(computer as unknown as OllamaLocal, servers)
  );
  holder.catalog = catalog;
  await servers.add({ address: ADDRESS, credential: { type: 'none' }, name: 'gpu', kind: 'ollama', access: 'chat' });
  const id = (await servers.views())[1].id;
  const model = `local:srv-${id}:qwen3:8b`;

  const events: ChatStreamEvent[] = [];
  const stream = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
    emit({ type: 'content', text: 'hi', stopReason: 'end_turn' });
  });
  const service = new ChatService({
    store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-server-health-')), 'claude-hosted-default'),
    queue: new MessageQueue(() => undefined),
    models: catalog,
    modelMemory: { read: async () => null, record: vi.fn(async () => {}) },
    local: { stream } as unknown as OllamaLocal,
    access: { list: async () => [] } as unknown as AccessStore,
    logger,
    preferredModel: 'claude-hosted-default',
    getApiClient: () => null,
    isDeviceLocal: () => true,
    getEnvironmentUrl: () => 'https://hosted.example.com',
    emit: event => events.push(event),
  });
  services.push(service);
  const session = await service.createSession();
  await service.setSessionModel(session.id, model);
  await service.setSessionReasoningEffort(session.id, THINKING_OFF_SETTING);

  return {
    catalog,
    model,
    setDown: (isDown: boolean) => {
      if (isDown) down.add(ADDRESS);
      else down.delete(ADDRESS);
    },
    holdComputer: (gate: Promise<void>) => (computerGate = gate),
    /** A health check of the server, through to its `changed` emit. */
    check: async () => {
      changed.mockClear();
      await servers.check(id);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    },
    /** Sends one message and returns the request the turn streamed. */
    send: async () => {
      const before = stream.mock.calls.length;
      expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
      await vi.waitUntil(() => !service.isSessionBusy(session.id));
      return stream.mock.calls.slice(before).find(([request]) => request.sessionId === session.id)?.[0];
    },
    lastRow: () => catalog.lastLocal()?.find(option => option.id === model),
  };
}

const FULL_ROW = {
  supportsTools: true,
  supportsVision: false,
  thinkingToggle: true,
  contextWindow: expect.any(Number),
};

describe('a turn on a saved server whose health changed', () => {
  it('lists again when the last list was read while the server was down, then runs on its full row', async () => {
    const harness = await fixture();
    harness.setDown(true);
    await harness.check();
    await harness.catalog.listLocal(true);
    harness.setDown(false);
    await harness.check();
    expect(harness.lastRow()?.unavailable).toMatch(/gpu is unreachable/);

    expect((await harness.send())?.thinking).toBe(false);
    expect(harness.lastRow()).toMatchObject(FULL_ROW);
    expect(harness.lastRow()).not.toHaveProperty('unavailable');
  });

  it('lists again when the server came back during the read that listed it down', async () => {
    const harness = await fixture();
    harness.setDown(true);
    await harness.check();
    let release = () => {};
    harness.holdComputer(new Promise<void>(resolve => (release = resolve)));
    const read = harness.catalog.listLocal(true);
    harness.setDown(false);
    await harness.check();
    release();
    await read;
    expect(harness.lastRow()?.unavailable).toMatch(/gpu is unreachable/);

    expect((await harness.send())?.thinking).toBe(false);
    expect(harness.lastRow()).toMatchObject(FULL_ROW);
  });

  it('runs on the last list without listing again after a check of a healthy server', async () => {
    const harness = await fixture();
    await harness.catalog.listLocal(true);
    await harness.check();
    const listLocal = vi.spyOn(harness.catalog, 'listLocal');

    expect((await harness.send())?.thinking).toBe(false);
    expect(listLocal).not.toHaveBeenCalled();
  });
});

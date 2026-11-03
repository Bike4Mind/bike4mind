import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { FetchLike } from '@bike4mind/local-models';
import { THINKING_OFF_SETTING, type ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModels } from '../modelServers/LocalModels';
import { ModelServerRegistry, PICKER_LIST_WAIT_MS } from '../modelServers/ModelServerRegistry';
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
async function fixture(options: { signedIn?: boolean } = {}) {
  const down = new Set<string>();
  let computerGate: Promise<void> = Promise.resolve();
  let listingGate: Promise<void> = Promise.resolve();
  const fetchFor = (): FetchLike => async input => {
    const url = new URL(String(input));
    if (down.has(url.origin)) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    if (url.pathname === '/api/version') return Response.json({ version: '0.12.0' });
    if (url.pathname === '/api/tags') {
      await listingGate;
      return Response.json({ models: [{ name: 'qwen3:8b' }] });
    }
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
  const api = {
    get: vi.fn(async () => ({})),
    getAxiosInstance: () => ({ post: vi.fn() }),
  } as unknown as AuthenticatedApiClient;
  const service = new ChatService({
    store: new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-server-health-')), 'claude-hosted-default'),
    queue: new MessageQueue(() => undefined),
    models: catalog,
    modelMemory: { read: async () => null, record: vi.fn(async () => {}) },
    local: { stream } as unknown as OllamaLocal,
    access: { list: async () => [] } as unknown as AccessStore,
    logger,
    preferredModel: 'claude-hosted-default',
    getApiClient: () => (options.signedIn ? api : null),
    isDeviceLocal: () => !options.signedIn,
    getEnvironmentUrl: () => 'https://hosted.example.com',
    emit: event => events.push(event),
  });
  services.push(service);
  const session = await service.createSession();
  await service.setSessionModel(session.id, model);
  await service.setSessionReasoningEffort(session.id, THINKING_OFF_SETTING);

  const turnRequest = () => stream.mock.calls.find(([request]) => request.sessionId === session.id)?.[0];
  /** Starts one message; the turn runs on after this returns. */
  const start = async () => expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
  /** Waits for the turn to end and returns the request it streamed, if any. */
  const finish = async () => {
    await vi.waitUntil(() => !service.isSessionBusy(session.id), { timeout: 5_000 });
    return turnRequest();
  };
  return {
    catalog,
    model,
    setDown: (isDown: boolean) => {
      if (isDown) down.add(ADDRESS);
      else down.delete(ADDRESS);
    },
    holdComputer: (gate: Promise<void>) => (computerGate = gate),
    /** Holds the server's model listings until `gate` settles; a rejection fails them. */
    holdListing: (gate: Promise<void>) => {
      gate.catch(() => undefined);
      listingGate = gate;
    },
    /** A health check of the server, through to its `changed` emit. */
    check: async () => {
      changed.mockClear();
      await servers.check(id);
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    },
    start,
    finish,
    send: async () => {
      stream.mockClear();
      await start();
      return finish();
    },
    turnRequest,
    turnError: () =>
      events.find((event): event is Extract<ChatStreamEvent, { type: 'error' }> => {
        return event.type === 'error' && event.sessionId === session.id;
      })?.message,
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

describe('a turn on a saved server that is still listing', () => {
  it('waits for the listing the picker showed as pending, then runs on its full row', async () => {
    const harness = await fixture({ signedIn: true });
    let release = () => {};
    harness.holdListing(new Promise<void>(resolve => (release = resolve)));
    vi.useFakeTimers();
    try {
      const read = harness.catalog.listLocal(true);
      await vi.advanceTimersByTimeAsync(PICKER_LIST_WAIT_MS);
      await read;
    } finally {
      vi.useRealTimers();
    }
    expect(harness.lastRow()?.pending).toBe(true);

    await harness.start();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(harness.turnRequest()).toBeUndefined();
    release();
    expect((await harness.finish())?.thinking).toBe(false);
    expect(harness.lastRow()).toMatchObject(FULL_ROW);
  });

  it('waits past the picker wait for a listing a cold cache has to read', async () => {
    const harness = await fixture({ signedIn: true });
    harness.catalog.forgetLocal();
    let release = () => {};
    harness.holdListing(new Promise<void>(resolve => (release = resolve)));

    await harness.start();
    await new Promise(resolve => setTimeout(resolve, PICKER_LIST_WAIT_MS + 300));
    expect(harness.turnRequest()).toBeUndefined();
    release();
    expect((await harness.finish())?.thinking).toBe(false);
    expect(harness.lastRow()).toMatchObject(FULL_ROW);
  }, 15_000);

  it('fails with the server named when its listing fails, without streaming', async () => {
    const harness = await fixture({ signedIn: true });
    harness.catalog.forgetLocal();
    harness.holdListing(Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })));

    await harness.start();
    expect(await harness.finish()).toBeUndefined();
    expect(harness.turnError()).toMatch(/^gpu is unreachable\. Pick another model, or check the server under Settings/);
  });
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { localBackend, localModelId, NO_LOCAL_MODEL, type ChatModelOption, type ChatStreamEvent } from '@shared/chat';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import { MessageQueue } from './MessageQueue';
import type { ModelCatalog } from './ModelCatalog';
import { LocalModelRemovedError, OLLAMA_RUNTIME_ID, type OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

const HOSTED_DEFAULT = 'claude-hosted-default';
const option = (name: string): ChatModelOption => ({
  id: localModelId(OLLAMA_RUNTIME_ID, name),
  name,
  backend: localBackend(OLLAMA_RUNTIME_ID),
  supportsTools: true,
});
const QWEN = option('qwen2.5:0.5b');
const GEMMA = option('gemma3:270m');
const services: ChatService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.dispose();
});

type Mode = 'signed-in' | 'device-local' | 'expired';

async function fixture(options: {
  mode: Mode;
  local: ChatModelOption[];
  remembered?: string | null;
  /** The catalog's last local list; left out, the catalog has no lastLocal at all. */
  last?: ChatModelOption[] | null;
}) {
  const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-signed-out-local-')), HOSTED_DEFAULT);
  const events: ChatStreamEvent[] = [];
  const stream = vi.fn<OllamaLocal['stream']>(async (_request, emit) => {
    emit({ type: 'content', text: 'hi', stopReason: 'end_turn' });
  });
  const api = {
    get: vi.fn(async () => ({})),
    getAxiosInstance: () => ({ post: vi.fn() }),
  } as unknown as AuthenticatedApiClient;
  const local = { current: options.local };
  const record = vi.fn(async () => {});
  const last = { current: options.last ?? null };
  // Like ModelCatalog: a read refreshes the last list, and forgetLocal drops it.
  const listLocal = vi.fn(async (_force?: boolean) => {
    last.current = local.current;
    return local.current;
  });
  const forgetLocal = vi.fn(() => {
    last.current = null;
  });
  const service = new ChatService({
    store,
    queue: new MessageQueue(() => undefined),
    models: {
      list: async () => ({ models: local.current }),
      listLocal,
      cached: () => local.current,
      forgetLocal,
      ...(options.last === undefined ? {} : { lastLocal: () => last.current }),
    } as unknown as ModelCatalog,
    modelMemory: { read: async () => options.remembered ?? null, record },
    local: { stream } as unknown as OllamaLocal,
    access: { list: async () => [] } as unknown as AccessStore,
    logger: { debug: vi.fn(), warn: vi.fn() },
    preferredModel: HOSTED_DEFAULT,
    getApiClient: () => (options.mode === 'signed-in' ? api : null),
    isDeviceLocal: () => options.mode === 'device-local',
    getEnvironmentUrl: () => 'https://hosted.example.com',
    emit: event => events.push(event),
  });
  services.push(service);
  const settled = (id: string) => vi.waitUntil(() => events.some(e => e.type === 'done' && e.sessionId === id));
  return { service, store, stream, local, events, record, settled, listLocal, forgetLocal };
}

describe('device-local chat with no usable local model', () => {
  it('starts conversations on the placeholder, never the hosted default', async () => {
    const { service } = await fixture({ mode: 'device-local', local: [] });
    expect((await service.createSession()).model).toBe(NO_LOCAL_MODEL);
    expect(await service.modelForNewSession()).toBe(NO_LOCAL_MODEL);
  });

  it('refuses a send, stores no message, and streams nothing', async () => {
    const { service, store, stream } = await fixture({ mode: 'device-local', local: [] });
    const session = await service.createSession();
    expect(await service.send(session.id, 'hello')).toMatchObject({
      ok: false,
      error: expect.stringContaining('No local model'),
    });
    expect(stream).not.toHaveBeenCalled();
    expect((await store.get(session.id))?.messages).toEqual([]);
  });

  it('moves a hosted conversation to a local model once one exists, with a notice', async () => {
    const { service, store, stream, local, settled } = await fixture({ mode: 'device-local', local: [] });
    const session = await service.createSession();
    await service.setSessionModel(session.id, 'claude-opus-5');
    expect(await service.send(session.id, 'hello')).toMatchObject({ ok: false });

    local.current = [QWEN];
    const result = await service.send(session.id, 'hello');
    expect(result).toMatchObject({
      ok: true,
      notice: expect.stringContaining('Switched this conversation to qwen2.5:0.5b'),
    });
    await settled(session.id);
    expect((await store.get(session.id))?.model).toBe(QWEN.id);
    expect(stream.mock.calls.every(([request]) => request.model === QWEN.id)).toBe(true);
  });

  it('sends on the last local list without asking Ollama when it has the model, however old', async () => {
    const { service, listLocal, settled } = await fixture({ mode: 'device-local', local: [QWEN], last: [QWEN] });
    const session = await service.createSession();
    expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
    await settled(session.id);
    expect(await service.send(session.id, 'again')).toMatchObject({ ok: true });
    await vi.waitUntil(() => !service.isSessionBusy(session.id));
    expect(listLocal).not.toHaveBeenCalled();
  });

  it('rereads once, forced, when the last list lacks the model, then switches as before', async () => {
    const { service, store, listLocal, settled } = await fixture({
      mode: 'device-local',
      local: [GEMMA],
      last: [QWEN, GEMMA],
    });
    const session = await service.createSession();
    await service.setSessionModel(session.id, localModelId(OLLAMA_RUNTIME_ID, 'llama3.2'));
    expect(await service.send(session.id, 'hello')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('llama3.2 is not available on this device'),
    });
    await settled(session.id);
    expect(listLocal.mock.calls).toEqual([[true]]);
    expect((await store.get(session.id))?.model).toBe(GEMMA.id);
  });

  it('reads Ollama once when there is no last list yet', async () => {
    const { service, listLocal, settled } = await fixture({ mode: 'device-local', local: [QWEN], last: null });
    const session = await service.createSession();
    expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
    await settled(session.id);
    expect(listLocal.mock.calls).toEqual([[true]]);
  });

  it('forgets the list when the model was removed outside the app, so the next send switches', async () => {
    const { service, store, stream, local, listLocal, forgetLocal } = await fixture({
      mode: 'device-local',
      local: [QWEN, GEMMA],
      last: [QWEN, GEMMA],
    });
    const session = await service.createSession();
    await service.setSessionModel(session.id, QWEN.id);
    local.current = [GEMMA];
    // Every request to a removed model fails, the title request beside the turn included.
    stream.mockImplementation(async (request, emit) => {
      if (request.model === QWEN.id) throw new LocalModelRemovedError();
      emit({ type: 'content', text: 'hi', stopReason: 'end_turn' });
    });
    expect(await service.send(session.id, 'hello')).toMatchObject({ ok: true });
    await vi.waitUntil(() => forgetLocal.mock.calls.length > 0 && !service.isSessionBusy(session.id));
    expect(listLocal).not.toHaveBeenCalled();

    expect(await service.send(session.id, 'again')).toMatchObject({
      ok: true,
      notice: expect.stringContaining('qwen2.5:0.5b is not available on this device'),
    });
    await vi.waitUntil(() => !service.isSessionBusy(session.id));
    expect(listLocal.mock.calls).toEqual([[true]]);
    expect((await store.get(session.id))?.model).toBe(GEMMA.id);
  });

  it('moves a placeholder conversation without a notice', async () => {
    const { service, local } = await fixture({ mode: 'device-local', local: [] });
    const session = await service.createSession();
    local.current = [QWEN];
    expect(await service.send(session.id, 'hello')).toEqual({ ok: true, messageId: expect.any(String) });
  });

  it('switches a deleted local model to the pick, with a notice', async () => {
    const { service, store, local, settled } = await fixture({ mode: 'device-local', local: [QWEN, GEMMA] });
    const session = await service.createSession();
    await service.setSessionModel(session.id, QWEN.id);
    local.current = [GEMMA];
    const result = await service.send(session.id, 'hello');
    expect(result).toMatchObject({
      ok: true,
      notice: expect.stringContaining('qwen2.5:0.5b is not available on this device'),
    });
    await settled(session.id);
    expect((await store.get(session.id))?.model).toBe(GEMMA.id);
  });
});

describe('the model a conversation settles on', () => {
  it('is the remembered pick when listed, for a new conversation, a send and settleSessionModel alike', async () => {
    const { service, store, local, record, settled } = await fixture({
      mode: 'device-local',
      local: [],
      remembered: QWEN.id,
    });
    const first = await service.createSession();
    const second = await service.createSession();
    local.current = [GEMMA, QWEN];

    const settledSummary = await service.settleSessionModel(first.id);
    expect(settledSummary?.session.model).toBe(QWEN.id);
    expect((await store.get(first.id))?.model).toBe(QWEN.id);
    expect(record).not.toHaveBeenCalled();

    await service.send(second.id, 'hello');
    await settled(second.id);
    expect((await store.get(second.id))?.model).toBe(QWEN.id);
    expect((await service.createSession()).model).toBe(QWEN.id);
  });

  it('is the first listed model with nothing remembered', async () => {
    const { service, local } = await fixture({ mode: 'device-local', local: [] });
    const session = await service.createSession();
    local.current = [GEMMA, QWEN];
    expect((await service.settleSessionModel(session.id))?.session.model).toBe(GEMMA.id);
  });

  it('changes nothing for a model that is already listed or when no list exists', async () => {
    const { service, local } = await fixture({ mode: 'device-local', local: [QWEN] });
    const session = await service.createSession();
    expect(await service.settleSessionModel(session.id)).toBeNull();
    local.current = [];
    expect(await service.settleSessionModel(session.id)).toBeNull();
  });
});

describe('an expired signed-in session', () => {
  it('keeps the Sign in refusal and never moves a hosted conversation onto a local model', async () => {
    const { service, store, stream, local } = await fixture({ mode: 'expired', local: [] });
    const session = await service.createSession();
    await service.setSessionModel(session.id, 'claude-opus-5');
    local.current = [QWEN];

    expect(await service.send(session.id, 'hello')).toEqual({ ok: false, error: 'Sign in to send a message.' });
    expect(await service.settleSessionModel(session.id)).toBeNull();
    expect((await store.get(session.id))?.model).toBe('claude-opus-5');
    expect((await store.get(session.id))?.messages).toEqual([]);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('signed-in chat', () => {
  it('keeps the hosted default with no models', async () => {
    const { service } = await fixture({ mode: 'signed-in', local: [] });
    expect((await service.createSession()).model).toBe(HOSTED_DEFAULT);
  });
});

import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { localBackend, localModelId, type ChatModelOption, type ChatStreamEvent } from '@shared/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { MessageQueue } from './MessageQueue';
import { OLLAMA_RUNTIME_ID, type OllamaLocal } from './OllamaLocal';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const HOSTED: ChatModelOption = { id: 'test-model', name: 'Test', backend: 'anthropic' };
const LOCAL: ChatModelOption = {
  id: localModelId(OLLAMA_RUNTIME_ID, 'qwen3:0.6b'),
  name: 'qwen3:0.6b',
  backend: localBackend(OLLAMA_RUNTIME_ID),
  supportsTools: true,
};

describe('ChatService reply stats', () => {
  let streams: PassThrough[];
  let events: ChatStreamEvent[];
  let store: SessionStore;
  let post: ReturnType<typeof vi.fn>;
  let localStream: ReturnType<typeof vi.fn<OllamaLocal['stream']>>;
  let accessList: ReturnType<typeof vi.fn<AccessStore['list']>>;
  const services: ChatService[] = [];

  beforeEach(async () => {
    const emitted: ChatStreamEvent[] = [];
    events = emitted;
    const opened: PassThrough[] = [];
    streams = opened;
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-stats-')));
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-stats-sessions-')), 'test-model');
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      opened.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });
    localStream = vi.fn<OllamaLocal['stream']>();
    accessList = vi.fn<AccessStore['list']>(async () => [root]);
    const service = new ChatService({
      store,
      models: {
        list: async () => ({ models: [HOSTED, LOCAL] }),
        listLocal: async () => [LOCAL],
        // Empty, so no title request opens a stream of its own; see pickTitleModel.
        cached: () => [],
      } as unknown as ModelCatalog,
      local: { stream: localStream } as unknown as OllamaLocal,
      access: { list: accessList } as unknown as AccessStore,
      queue: new MessageQueue(() => undefined),
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
    services.push(service);
  });

  afterEach(() => {
    for (const service of services.splice(0)) service.dispose();
    vi.restoreAllMocks();
  });

  /** Every tool round takes at least TOOL_MS, so tool time is something a test can see. */
  const TOOL_MS = 60;
  const slowTools = () => {
    type RunTools = (...args: unknown[]) => Promise<unknown>;
    const proto = ChatService.prototype as unknown as { runTools: RunTools };
    const run = proto.runTools;
    vi.spyOn(proto, 'runTools').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      await pause(TOOL_MS);
      return run.apply(this, args);
    });
  };

  async function session(model = 'test-model'): Promise<string> {
    const { id } = await services[0].createSession();
    await services[0].setSessionModel(id, model);
    return id;
  }

  const thinkingPhases = () => events.filter(event => event.type === 'phase' && event.phase.kind === 'thinking').length;

  const settled = () =>
    vi.waitUntil(() => events.find(event => event.type === 'done' || event.type === 'error'), {
      timeout: 3000,
      interval: 5,
    });

  async function hostedTurn(write: (stream: PassThrough) => Promise<void>) {
    const id = await session();
    await services[0].send(id, 'go');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    await write(streams[0]);
    streams[0].write(frame('[DONE]'));
    const end = await settled();
    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    return { end, reply };
  }

  it('stores and announces stats on a plain reply, which keeps no rounds', async () => {
    const { end, reply } = await hostedTurn(async stream => {
      stream.write(frame({ type: 'content', text: 'Hello' }));
      await pause(20);
      stream.write(frame({ type: 'content', text: ' there', usage: { inputTokens: 10, outputTokens: 2 } }));
    });

    expect(reply?.rounds).toBeUndefined();
    expect(reply?.stats).toEqual({
      totalMs: expect.any(Number),
      modelMs: expect.any(Number),
      toolMs: 0,
      firstTokenMs: expect.any(Number),
    });
    expect(reply!.stats!.totalMs).toBeGreaterThanOrEqual(reply!.stats!.modelMs);
    expect(reply!.stats!.modelMs).toBeGreaterThanOrEqual(15);
    expect(end).toMatchObject({ type: 'done', stats: reply?.stats });
  });

  it('times the first token and the total from the request, not the setup before it', async () => {
    const folders = accessList.getMockImplementation()!;
    accessList.mockImplementation(async () => {
      await pause(150);
      return folders();
    });
    const { reply } = await hostedTurn(async stream => {
      stream.write(frame({ type: 'content', text: 'Hello', usage: { outputTokens: 1 } }));
    });

    const stats = reply!.stats!;
    expect(stats.totalMs - stats.modelMs).toBeLessThan(100);
    expect(stats.firstTokenMs).toBeLessThanOrEqual(stats.modelMs);
  });

  it('times hosted thinking from the markers around it', async () => {
    const { reply } = await hostedTurn(async stream => {
      stream.write(frame({ type: 'content', text: '<think>' }));
      await pause(40);
      stream.write(frame({ type: 'content', text: '</think>' }));
      stream.write(frame({ type: 'content', text: 'Answer', usage: { outputTokens: 50, reasoningTokens: 30 } }));
    });

    expect(reply?.stats?.reasoningMs).toBeGreaterThanOrEqual(35);
    expect(reply?.stats).toMatchObject({ reasoningTokens: 30 });
    expect(reply?.stats?.derived).toBeUndefined();
    expect(reply?.usage).toMatchObject({ reasoningTokens: 30 });
    expect(thinkingPhases()).toBe(1);
  });

  it('estimates hosted thinking it never saw from the wait before the text, and says so', async () => {
    const { reply } = await hostedTurn(async stream => {
      await pause(30);
      stream.write(frame({ type: 'content', text: 'Answer', usage: { outputTokens: 50, reasoningTokens: 30 } }));
    });

    expect(reply?.stats?.reasoningMs).toBeGreaterThanOrEqual(25);
    expect(reply?.stats?.derived).toEqual(['reasoningMs']);
  });

  it('counts tool time apart from model time', async () => {
    slowTools();
    const id = await session();
    await services[0].send(id, 'list');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'c1', name: 'glob_files', arguments: '{"pattern":"*"}' }] })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'nothing here' }));
    streams[1].write(frame('[DONE]'));
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.rounds).toHaveLength(2);
    expect(reply?.rounds?.[1].timing?.firstTextAt).toEqual(expect.any(Number));
    const stats = reply!.stats!;
    expect(stats.toolMs).toBeGreaterThanOrEqual(TOOL_MS - 5);
    expect(stats.totalMs).toBeGreaterThanOrEqual(stats.modelMs + stats.toolMs);
  });

  it('starts a new reply after a mid-turn message with its own clock and no tool time', async () => {
    slowTools();
    const id = await session();
    await services[0].send(id, 'list');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    expect(await services[0].send(id, 'and the hidden ones?')).toMatchObject({ ok: true, queued: true });
    streams[0].write(
      frame({ type: 'tool_use', tools: [{ id: 'c1', name: 'glob_files', arguments: '{"pattern":"*"}' }] })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'none' }));
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.filter(event => event.type === 'done').length === 2, { timeout: 3000 });

    const replies = (await store.get(id))!.messages.filter(message => message.role === 'assistant');
    expect(replies).toHaveLength(2);
    expect(replies[0].stats!.toolMs).toBeGreaterThanOrEqual(TOOL_MS - 5);
    expect(replies[1].stats!.toolMs).toBe(0);
    expect(replies[1].stats!.totalMs - replies[1].stats!.modelMs).toBeLessThan(TOOL_MS / 2);
  });

  it('times a tool round from the call starting, so its tokens are rated over the time they took', async () => {
    const id = await session();
    await services[0].send(id, 'list');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(frame({ type: 'content', toolStarted: { name: 'glob_files', id: 'c1' } }));
    await pause(300);
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'c1', name: 'glob_files', arguments: '{"pattern":"*"}' }],
        usage: { outputTokens: 40 },
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'nothing here', usage: { outputTokens: 3 } }));
    streams[1].write(frame('[DONE]'));
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    const timing = reply!.rounds![0].timing!;
    expect(timing.endedAt - timing.firstTokenAt!).toBeGreaterThanOrEqual(280);
    expect(reply?.stats?.generation?.tokens).toBe(39);
    expect(reply?.stats?.generation?.ms).toBeGreaterThanOrEqual(280);
  });

  it('estimates a self-hosted model thinking tokens from its thinking frames', async () => {
    localStream.mockImplementation(async (_request, emit) => {
      for (let i = 0; i < 3; i++) {
        emit({ type: 'content', text: `<think>step ${i} </think>` });
        await pause(10);
      }
      emit({ type: 'content', text: 'Done.' });
      emit({
        type: 'content',
        stopReason: 'end_turn',
        usage: { inputTokens: 40, outputTokens: 10 },
        rate: { evalTokens: 10, evalMs: 200, totalMs: 900, loadMs: 300 },
      });
    });
    const id = await session(LOCAL.id);
    await services[0].send(id, 'think');
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.stats).toMatchObject({ reasoningTokens: 3, derived: ['reasoningTokens'] });
    expect(reply?.stats?.reasoningMs).toBeGreaterThanOrEqual(15);
    expect(thinkingPhases()).toBe(1);
    expect(reply?.usage?.rate).toEqual({ evalTokens: 10, evalMs: 200, totalMs: 900, loadMs: 300 });
    expect(reply?.rounds?.[0].timing).toMatchObject({
      firstReasoningAt: expect.any(Number),
      lastReasoningAt: expect.any(Number),
      firstTextAt: expect.any(Number),
    });
  });

  it.each([
    ['frame by frame', ['<think>', '\n\n', '</think>', '\n\nHello there']],
    ['in one frame', ['<think>\n\n</think>\n\nHello there']],
  ])('reports no thinking for an empty block from a model with thinking off, %s', async (_how, frames) => {
    localStream.mockImplementation(async (_request, emit) => {
      for (const text of frames) {
        emit({ type: 'content', text });
        await pause(5);
      }
      emit({ type: 'content', stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 8 } });
    });
    const id = await session(LOCAL.id);
    await services[0].send(id, 'hi');
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.content).toBe('Hello there');
    expect(reply?.stats).toBeDefined();
    expect(reply?.stats?.reasoningMs).toBeUndefined();
    expect(reply?.stats?.reasoningTokens).toBeUndefined();
    expect(reply?.stats?.derived).toBeUndefined();
    // Nor live: a thinking phase would start the rail's thinking clock for a reply that stores none.
    expect(thinkingPhases()).toBe(0);
  });

  it('times bare markers on a self-hosted model without counting them as thinking tokens', async () => {
    localStream.mockImplementation(async (_request, emit) => {
      emit({ type: 'content', text: '<think>' });
      await pause(40);
      emit({ type: 'content', text: '</think>' });
      emit({ type: 'content', text: 'Done.' });
      emit({ type: 'content', stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 30 } });
    });
    const id = await session(LOCAL.id);
    await services[0].send(id, 'think');
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.stats?.reasoningMs).toBeGreaterThanOrEqual(35);
    expect(reply?.stats?.reasoningTokens).toBeUndefined();
  });

  it('stamps the first text even when the filter held all of it back until the stream ended', async () => {
    localStream.mockImplementation(async (_request, emit) => {
      emit({ type: 'content', text: '<think>which bracket opens a tag</think>' });
      await pause(10);
      emit({ type: 'content', text: '<' });
      emit({ type: 'content', stopReason: 'end_turn', usage: { inputTokens: 40, outputTokens: 12 } });
    });
    const id = await session(LOCAL.id);
    await services[0].send(id, 'which bracket?');
    await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.content).toBe('<');
    expect(reply?.rounds?.[0].timing?.firstTextAt).toEqual(expect.any(Number));
  });

  it('never counts a hosted model thinking frames as tokens', async () => {
    const { reply } = await hostedTurn(async stream => {
      for (let i = 0; i < 3; i++) {
        stream.write(frame({ type: 'content', text: `<think>step ${i} </think>` }));
        await pause(10);
      }
      stream.write(frame({ type: 'content', text: 'Answer', usage: { outputTokens: 400 } }));
    });

    expect(reply?.stats?.reasoningMs).toBeGreaterThanOrEqual(15);
    expect(reply?.stats?.reasoningTokens).toBeUndefined();
  });

  it('keeps what was measured on a reply that failed', async () => {
    post.mockImplementationOnce(() => Promise.reject(new Error('upstream exploded')));
    const id = await session();
    await services[0].send(id, 'go');
    const end = await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.error).toBeTruthy();
    expect(reply?.stats).toMatchObject({ modelMs: expect.any(Number), toolMs: 0 });
    expect(end).toMatchObject({ type: 'error', stats: reply?.stats });
  });

  it('carries a continued reply on from the stats it stopped with', async () => {
    const id = await session();
    await store.appendMessage(id, { id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() });
    const earlier = { totalMs: 8_000, modelMs: 3_000, toolMs: 5_000, firstTokenMs: 200 };
    await store.appendMessage(id, {
      id: 'a1',
      role: 'assistant',
      content: 'partway',
      createdAt: new Date().toISOString(),
      stopReason: 'tool_turn_limit',
      stats: earlier,
    });

    await services[0].continueReply(id);
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    await pause(30);
    streams[0].write(frame({ type: 'content', text: ' and done' }));
    streams[0].write(frame('[DONE]'));
    const end = await settled();

    const reply = (await store.get(id))?.messages.find(message => message.id === 'a1');
    expect(reply?.stats).toMatchObject({ firstTokenMs: 200, toolMs: 5_000 });
    // Past what was stored: the update has to write the new run's stats, not keep the old ones.
    expect(reply!.stats!.totalMs).toBeGreaterThanOrEqual(8_025);
    expect(reply!.stats!.totalMs).toBeLessThan(8_000 + 3_000);
    expect(reply!.stats!.modelMs).toBeGreaterThanOrEqual(3_025);
    expect(end).toMatchObject({ type: 'done', stats: reply?.stats });
  });

  it('stores no stats on a continued reply stored before they were kept, whose earlier time is unknown', async () => {
    const id = await session();
    await store.appendMessage(id, { id: 'u1', role: 'user', content: 'go', createdAt: new Date().toISOString() });
    await store.appendMessage(id, {
      id: 'a1',
      role: 'assistant',
      content: 'partway',
      createdAt: new Date().toISOString(),
      stopReason: 'tool_turn_limit',
      usage: { outputTokens: 8_000 },
    });

    await services[0].continueReply(id);
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(frame({ type: 'content', text: ' and done', usage: { outputTokens: 4 } }));
    streams[0].write(frame('[DONE]'));
    const end = await settled();

    const reply = (await store.get(id))?.messages.find(message => message.id === 'a1');
    expect(reply?.usage?.outputTokens).toBe(8_004);
    expect(reply).not.toHaveProperty('stats');
    expect(end).toMatchObject({ type: 'done' });
    expect(end).not.toHaveProperty('stats');
  });

  it('stores no stats on a turn refused before it reached the model', async () => {
    accessList.mockRejectedValueOnce(new Error('the folder list could not be read'));
    const id = await session();
    await services[0].send(id, 'go');
    const end = await settled();

    const reply = (await store.get(id))?.messages.find(message => message.role === 'assistant');
    expect(reply?.error).toMatch(/folder list/);
    expect(post).not.toHaveBeenCalled();
    expect(reply).not.toHaveProperty('stats');
    expect(end).not.toHaveProperty('stats');
  });
});

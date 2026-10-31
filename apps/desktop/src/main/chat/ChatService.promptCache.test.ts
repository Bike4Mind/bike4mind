import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatModelOption, ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import { TITLE_INSTRUCTION } from './sessionTitle';
import type { AccessStore } from './tools/AccessStore';

const MODELS: ChatModelOption[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5', backend: 'anthropic', supportsOneHourCache: true },
  { id: 'claude-sonnet-4-5', name: 'Sonnet 4.5', backend: 'anthropic' },
  { id: 'gpt-5', name: 'GPT-5', backend: 'openai' },
];

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

interface Posted {
  body: { messages: { content: unknown }[]; options?: Record<string, unknown> };
  stream: PassThrough;
}

describe('ChatService prompt cache lifetime', () => {
  let posted: Posted[];
  let events: ChatStreamEvent[];
  let service: ChatService;
  let store: SessionStore;

  beforeEach(async () => {
    const opened: Posted[] = (posted = []);
    const emitted: ChatStreamEvent[] = (events = []);
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-cache-ttl-')));
    const post = vi.fn().mockImplementation((_url: string, body: Posted['body']) => {
      const stream = new PassThrough();
      opened.push({ body, stream });
      return Promise.resolve({ data: stream, status: 200 });
    });
    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-cache-ttl-sessions-')), 'claude-opus-5-5');
    service = new ChatService({
      store,
      models: { list: async () => ({ models: MODELS }), cached: () => MODELS } as unknown as ModelCatalog,
      access: { list: async () => [root] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => emitted.push(event),
    });
  });

  /** Runs one turn on `model` at `ttl` and returns the turn's request options and its 'done' event. */
  async function runTurn(model: string, ttl: '5m' | '1h') {
    const { id } = await service.createSession();
    await service.setSessionModel(id, model);
    await service.setSessionPromptCacheTtl(id, ttl);
    const before = Date.now();
    await service.send(id, 'go');
    const turn = await vi.waitUntil(() => posted.find(entry => entry.body.messages[0]?.content !== TITLE_INSTRUCTION), {
      timeout: 3000,
      interval: 5,
    });
    turn.stream.write(frame({ type: 'content', text: 'hello' }));
    turn.stream.write(frame('[DONE]'));
    const done = await vi.waitUntil(
      () => events.find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done'),
      { timeout: 3000, interval: 5 }
    );
    const stored = (await service.getSession(id))?.messages.find(message => message.role === 'assistant');
    return { options: turn.body.options ?? {}, done, stored, before };
  }

  it('asks for the hour on a model that takes it and stamps the reply with it', async () => {
    const { options, done, stored, before } = await runTurn('claude-opus-5-5', '1h');

    expect(options).toMatchObject({ cacheTtl: '1h' });
    expect(done.promptCache).toMatchObject({ ttl: '1h', model: 'claude-opus-5-5' });
    expect(done.promptCache!.cachedAt).toBeGreaterThanOrEqual(before);
    expect(stored?.promptCache).toEqual(done.promptCache);
  });

  it('sends no lifetime at 5 minutes, or on a Claude model without the hour, and stamps 5 minutes', async () => {
    const fiveMinutes = await runTurn('claude-opus-5-5', '5m');
    expect(fiveMinutes.options).not.toHaveProperty('cacheTtl');
    expect(fiveMinutes.done.promptCache).toMatchObject({ ttl: '5m' });

    posted.length = 0;
    events.length = 0;
    const older = await runTurn('claude-sonnet-4-5', '1h');
    expect(older.options).not.toHaveProperty('cacheTtl');
    expect(older.done.promptCache).toMatchObject({ ttl: '5m', model: 'claude-sonnet-4-5' });
  });

  it('stores the stamp on a continued reply, not just on its done event', async () => {
    const { id } = await service.createSession();
    await store.appendMessage(id, {
      id: 'resume-me',
      role: 'assistant',
      content: 'Partial',
      createdAt: new Date().toISOString(),
      stopReason: 'tool_turn_limit',
    });
    expect(await service.continueReply(id)).toMatchObject({ ok: true });
    const turn = await vi.waitUntil(() => posted.find(entry => entry.body.messages[0]?.content !== TITLE_INSTRUCTION), {
      timeout: 3000,
      interval: 5,
    });
    turn.stream.write(frame({ type: 'content', text: 'more' }));
    turn.stream.write(frame('[DONE]'));
    const done = await vi.waitUntil(
      () => events.find((event): event is Extract<ChatStreamEvent, { type: 'done' }> => event.type === 'done'),
      { timeout: 3000, interval: 5 }
    );

    expect(done.promptCache).toMatchObject({ ttl: '5m', model: 'claude-opus-5-5' });
    const stored = (await service.getSession(id))?.messages.find(message => message.id === 'resume-me');
    expect(stored?.promptCache).toEqual(done.promptCache);
  });

  it('stamps nothing on a model Desktop does not cache', async () => {
    const { options, done, stored } = await runTurn('gpt-5', '1h');

    expect(options).not.toHaveProperty('cacheTtl');
    expect(done.promptCache).toBeUndefined();
    expect(stored?.promptCache).toBeUndefined();
  });
});

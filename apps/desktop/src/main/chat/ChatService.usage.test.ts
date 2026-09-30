import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addUsage, ChatService } from './ChatService';
import type { ModelCatalog } from './ModelCatalog';
import { SessionStore } from './SessionStore';
import type { AccessStore } from './tools/AccessStore';

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

describe('addUsage', () => {
  it('sums the round trips of one turn', () => {
    expect(addUsage({ inputTokens: 900, outputTokens: 100 }, { inputTokens: 1200, outputTokens: 50 })).toEqual({
      inputTokens: 2100,
      outputTokens: 150,
    });
  });

  it('keeps an unreported field unreported rather than calling it zero', () => {
    expect(addUsage(undefined, undefined)).toBeUndefined();
    expect(addUsage({ inputTokens: 10 }, { inputTokens: 5 })).toEqual({ inputTokens: 15 });
    expect(addUsage(undefined, { outputTokens: 7 })).toEqual({ outputTokens: 7 });
  });
});

describe('ChatService usage reporting', () => {
  let service: ChatService;
  let store: SessionStore;
  let backend: string;
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-usage-')));
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');

    store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-usage-sessions-')), 'test-model');
    backend = 'anthropic';
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
      models: {
        list: async () => ({ models: [{ id: 'test-model', name: 'Test', backend }] }),
        cached: () => [],
      } as unknown as ModelCatalog,
      access: { list: async () => [root] } as unknown as AccessStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
      getApiClient: () =>
        ({
          get: vi.fn().mockResolvedValue({}),
          getAxiosInstance: () => ({ post }),
        }) as unknown as AuthenticatedApiClient,
      getEnvironmentUrl: () => 'http://localhost:3000',
      emit: event => events.push(event),
    });
  });

  it('reports the running total after each round trip, not only with the reply', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'what is here?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
        usage: { inputTokens: 900, outputTokens: 100 },
      })
    );
    streams[0].write(frame('[DONE]'));

    // The first count is available while the turn is still running, which is the whole point:
    // the status line shows a real number without waiting for the reply.
    const first = await vi.waitUntil(() => events.find(event => event.type === 'usage'), {
      timeout: 3000,
      interval: 5,
    });
    expect(first).toMatchObject({ usage: { inputTokens: 900, outputTokens: 100 } });

    await vi.waitUntil(() => post.mock.calls.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(frame({ type: 'content', text: 'one file.', usage: { inputTokens: 1200, outputTokens: 40 } }));
    streams[1].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ usage: { inputTokens: 2100, outputTokens: 140 } });

    const totals = events.filter(event => event.type === 'usage');
    expect(totals).toHaveLength(2);
  });

  it('bills an explore sub-agent to the turn that called it', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'how is this laid out?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'explore', arguments: JSON.stringify({ question: 'what files exist?' }) }],
        usage: { inputTokens: 900, outputTokens: 100 },
      })
    );
    streams[0].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    const nested = post.mock.calls[1][1] as { options: { tools: { toolSchema: { name: string } }[] } };
    expect(nested.options.tools.map(tool => tool.toolSchema.name).sort()).toEqual([
      'file_read',
      'glob_files',
      'grep_search',
    ]);
    streams[1].write(frame({ type: 'content', text: 'tiny.txt only.', usage: { inputTokens: 300, outputTokens: 20 } }));
    streams[1].write(frame('[DONE]'));

    await vi.waitUntil(() => streams.length === 3, { timeout: 3000, interval: 5 });
    const resumed = post.mock.calls[2][1] as { messages: { content: unknown }[] };
    expect(JSON.stringify(resumed.messages.at(-1)?.content)).toContain('tiny.txt only.');
    streams[2].write(frame({ type: 'content', text: 'one file.', usage: { inputTokens: 1200, outputTokens: 40 } }));
    streams[2].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done).toMatchObject({ usage: { inputTokens: 2400, outputTokens: 160 } });
  });

  it('says nothing about tokens when the server reported none', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'hello');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });

    streams[0].write(frame({ type: 'content', text: 'hi' }));
    streams[0].write(frame('[DONE]'));

    const done = await vi.waitUntil(() => events.find(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    expect(done && 'usage' in done ? done.usage : 'missing').toBeUndefined();
    expect(events.some(event => event.type === 'usage')).toBe(false);
  });

  type Wire = { messages: { role: string; content: unknown; cache?: boolean }[] };
  const wireOf = (index: number): Wire => post.mock.calls[index][1] as Wire;
  const markers = (index: number): (boolean | undefined)[] => wireOf(index).messages.map(message => message.cache);

  async function runTwoRoundTurn(): Promise<string> {
    const { id } = await service.createSession();
    await service.send(id, 'what is here?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'glob_files', arguments: JSON.stringify({ pattern: '*' }) }],
        usage: { inputTokens: 900, cacheCreationInputTokens: 4000, outputTokens: 100 },
        credits: { used: 5, usdCost: 0.05 },
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    streams[1].write(
      frame({
        type: 'content',
        text: 'one file.',
        usage: { inputTokens: 50, cacheReadInputTokens: 4900, outputTokens: 40 },
        credits: { used: 2, usdCost: 0.02 },
      })
    );
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });
    return id;
  }

  it('marks the system message and only the last message, in every round', async () => {
    await runTwoRoundTurn();

    expect(markers(0)).toEqual([true, true]);
    expect(wireOf(0).messages[0].role).toBe('system');
    // Round 2 adds an assistant tool_use and a user tool_result: the old breakpoint on the
    // prompt is gone and the new one sits on the tool_result message.
    expect(markers(1)).toEqual([true, undefined, undefined, true]);
    expect(wireOf(1).messages[3].role).toBe('user');
  });

  it('sends no markers on a backend that would reject the flag', async () => {
    backend = 'bedrock';
    await runTwoRoundTurn();
    expect(markers(0).every(marker => marker === undefined)).toBe(true);
    expect(markers(1).every(marker => marker === undefined)).toBe(true);
  });

  it('never stores a cache flag on the session', async () => {
    const id = await runTwoRoundTurn();
    const stored = JSON.stringify((await store.get(id))?.messages);
    expect(stored).not.toContain('"cache"');
  });

  it('stores each round usage and the turn total, and keeps both off the wire', async () => {
    const id = await runTwoRoundTurn();
    const reply = (await store.get(id))?.messages.at(-1);

    expect(reply?.rounds?.map(round => round.usage)).toEqual([
      { inputTokens: 900, cacheCreationInputTokens: 4000, outputTokens: 100, creditsUsed: 5, usdCost: 0.05 },
      { inputTokens: 50, cacheReadInputTokens: 4900, outputTokens: 40, creditsUsed: 2, usdCost: 0.02 },
    ]);
    expect(reply?.usage).toEqual({
      inputTokens: 950,
      cacheCreationInputTokens: 4000,
      cacheReadInputTokens: 4900,
      outputTokens: 140,
      creditsUsed: 7,
      usdCost: 0.07,
    });

    await service.send(id, 'and again?');
    await vi.waitUntil(() => post.mock.calls.length === 3, { timeout: 3000, interval: 5 });
    expect(JSON.stringify(wireOf(2).messages.slice(1))).not.toMatch(
      /"(usage|usdCost|creditsUsed|cacheRead\w*|cacheCreation\w*)"/
    );
  });

  it('records the explore sub-loop usage on the tool call', async () => {
    const { id } = await service.createSession();
    await service.send(id, 'how is this laid out?');
    await vi.waitUntil(() => streams.length === 1, { timeout: 3000, interval: 5 });
    streams[0].write(
      frame({
        type: 'tool_use',
        tools: [{ id: 'call_1', name: 'explore', arguments: JSON.stringify({ question: 'what files exist?' }) }],
      })
    );
    streams[0].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 2, { timeout: 3000, interval: 5 });
    expect(markers(1)).toEqual([true, true]);
    streams[1].write(
      frame({ type: 'content', text: 'tiny.txt', usage: { inputTokens: 300, cacheReadInputTokens: 10 } })
    );
    streams[1].write(frame('[DONE]'));
    await vi.waitUntil(() => streams.length === 3, { timeout: 3000, interval: 5 });
    streams[2].write(frame({ type: 'content', text: 'done' }));
    streams[2].write(frame('[DONE]'));
    await vi.waitUntil(() => events.some(event => event.type === 'done'), { timeout: 3000, interval: 5 });

    const call = (await store.get(id))?.messages.at(-1)?.toolCalls?.[0];
    expect(call?.detail?.usage).toEqual({ inputTokens: 300, cacheReadInputTokens: 10 });
  });
});

import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { ChatStreamEvent } from '@shared/chat';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addUsage, ChatService } from './ChatService';
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
  let events: ChatStreamEvent[];
  let post: ReturnType<typeof vi.fn>;
  let streams: PassThrough[];

  beforeEach(async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-usage-')));
    await writeFile(join(root, 'tiny.txt'), 'z', 'utf8');

    const store = new SessionStore(await mkdtemp(join(tmpdir(), 'b4m-usage-sessions-')), 'test-model');
    events = [];
    streams = [];
    post = vi.fn().mockImplementation(() => {
      const stream = new PassThrough();
      streams.push(stream);
      return Promise.resolve({ data: stream, status: 200 });
    });

    service = new ChatService({
      store,
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
});
